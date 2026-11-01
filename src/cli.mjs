import { Command } from "commander";
import { open, writeFile, readFile, unlink, rm } from "node:fs/promises";
import { join, resolve, sep, parse } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  stateRoot,
  setupState,
  saveJSON,
  readJSON,
  httpsOrigin,
  PhoneError,
} from "./state.mjs";
import { serve, control } from "./service.mjs";
import { createShortcuts, powershell } from "./windows.mjs";
import { deployCloudflare, probeRelay } from "./relay.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = new Command()
  .name("codex-phone")
  .version("0.1.0")
  .option("--json", "Structured result")
  .option("--state <directory>", "Isolated private state directory");
let context;
async function ctx() {
  if (context) return context;
  const dir = resolve(cli.opts().state || stateRoot());
  if (
    dir === parse(dir).root ||
    dir === homedir() ||
    dir === root ||
    dir.startsWith(root + sep)
  )
    throw new PhoneError(
      "unsafe_state_directory",
      "Use a dedicated private directory outside the checkout.",
    );
  const config = await setupState(dir);
  context = { dir, config };
  return context;
}
function output(value) {
  const result = {
    status: value.ok === false ? "needs_user_action" : "ok",
    code: value.code || "ok",
    ...value,
  };
  console.log(JSON.stringify(result, null, cli.opts().json ? 0 : 2));
  if (value.ok === false) process.exitCode = 2;
  return result;
}
function openFile(path) {
  if (process.platform === "win32")
    spawn("explorer.exe", [path], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
}
async function start() {
  const { config, dir } = await ctx();
  try {
    return await control(config, "status");
  } catch (e) {
    if (e.code && e.code !== "service_not_running") throw e;
  }
  const logs = await open(join(dir, "service.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [join(root, "dist/cli.mjs"), "--state", dir, "serve"],
    {
      detached: true,
      stdio: ["ignore", logs.fd, logs.fd],
      windowsHide: true,
      env: {
        ...process.env,
        ...(config.proxy
          ? { HTTP_PROXY: config.proxy, HTTPS_PROXY: config.proxy }
          : {}),
      },
    },
  );
  await logs.close();
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const latest = await readJSON(join(dir, "config.json"), config);
    try {
      const result = await control(latest, "status");
      context.config = latest;
      return result;
    } catch {}
  }
  throw new PhoneError("service_start_failed", "The service did not start.", [
    "Read the private service.log; check owned ports and run doctor.",
  ]);
}
async function requireStopped(config) {
  try {
    await control(config, "status");
  } catch (e) {
    if (e.code === "service_not_running" || e.cause?.code === "ECONNREFUSED")
      return;
    throw e;
  }
  throw new PhoneError(
    "configuration_requires_stop",
    "Run stop before changing the active configuration.",
    ["Run stop, apply configuration, then start and doctor."],
  );
}
async function stopOwned(config) {
  try {
    await control(config, "stop", {});
  } catch (e) {
    if (e.code === "service_not_running" || e.cause?.code === "ECONNREFUSED")
      return;
    throw e;
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await control(config, "status");
    } catch (e) {
      if (e.cause?.code === "ECONNREFUSED") return;
      throw e;
    }
  }
  throw new PhoneError(
    "service_stop_timeout",
    "Owned service is still stopping; keep its state intact.",
  );
}
cli
  .command("setup")
  .option("--endpoint <https-origin>")
  .option("--proxy <url>")
  .option("--no-shortcuts")
  .action(async (options) => {
    const { config, dir } = await ctx();
    if (options.endpoint || options.proxy) await requireStopped(config);
    if (options.endpoint)
      config.relay = {
        provider: "provided",
        endpoint: httpsOrigin(options.endpoint),
      };
    if (options.proxy) {
      const url = new URL(options.proxy);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw Error("INVALID_PROXY");
      config.proxy = url.origin;
    }
    await saveJSON(join(dir, "config.json"), config);
    if (options.shortcuts) await createShortcuts(root, dir);
    output({
      ok: true,
      stateDirectory: dir,
      deviceId: config.deviceId,
      next: [
        "Use relay cloudflare deploy or setup --endpoint to configure your own HTTPS relay.",
        "Run start, then doctor, then pair.",
      ],
    });
  });
cli
  .command("start")
  .option("--open")
  .action(async (options) => {
    let result = await start();
    if (options.open) {
      const { config } = await ctx();
      for (
        let i = 0;
        i < 20 && result.desktop?.code === "desktop_starting";
        i++
      ) {
        await new Promise((r) => setTimeout(r, 250));
        result = await control(config, "status");
      }
      if (result.desktop?.ok === false)
        return output({
          ...result,
          ok: false,
          code: result.desktop.code,
          next: result.desktop.next || ["Run doctor --json."],
        });
    }
    output(result);
  });
cli.command("serve", { hidden: true }).action(async () => {
  const { config, dir } = await ctx();
  await serve(config, dir);
});
for (const name of ["status", "doctor"])
  cli.command(name).action(async () => {
    const { config } = await ctx();
    try {
      output(await control(config, name));
    } catch (e) {
      output({
        ok: false,
        code: e.code || "service_not_running",
        message: e.message,
        next: ["Run start; inspect the private service.log if it fails."],
      });
    }
  });
cli
  .command("pair")
  .option("--open")
  .action(async (options) => {
    await start();
    const { config, dir } = await ctx();
    if (!config.relay.endpoint) throw new PhoneError("relay_not_configured");
    const result = await control(config, "pair", {});
    const link =
      "codexphone-public://pair?" +
      new URLSearchParams({
        gateway: result.endpoint,
        code: result.code,
        device: result.deviceId,
      });
    const escape = (s) =>
      s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll('"', "&quot;");
    const page = join(dir, "pairing.html");
    await writeFile(
      page,
      `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Codex Phone pairing</title><style>body{font:20px system-ui;max-width:700px;margin:60px auto;padding:24px}strong{font-size:48px;letter-spacing:8px}input{width:100%}</style><h1>Codex Phone · 手机配对</h1><p>Gateway / 入口：${escape(result.endpoint)}</p><strong>${result.code}</strong><p>Expires in 10 minutes; one use. / 10 分钟内有效，仅可使用一次。</p><p>Install the public APK, then enter this address and code or paste this link:</p><input readonly value="${escape(link)}"><p>请勿分享配对码或本页面。Do not share this page.</p>`,
      { mode: 0o600 },
    );
    if (options.open) openFile(page);
    output({ ...result, ok: true, pairingPage: page, pairingLink: link });
  });
const phones = cli.command("phones");
phones.command("list").action(async () => {
  const { config } = await ctx();
  output({ ok: true, ...(await control(config, "phones")) });
});
phones.command("revoke <phoneId>").action(async (phoneId) => {
  const { config } = await ctx();
  output(await control(config, "revoke", { phoneId }));
});
cli.command("stop").action(async () => {
  const { config } = await ctx();
  await stopOwned(config);
  output({ ok: true });
});
cli.command("uninstall").action(async () => {
  const { config, dir } = await ctx();
  await stopOwned(config);
  if (process.platform === "win32")
    await powershell(
      `$f=Join-Path ([Environment]::GetFolderPath('Programs')) 'codex-phone';$s=New-Object -ComObject WScript.Shell;$stateArg='"'+${"'" + dir.replaceAll("'", "''") + "'"}+'"';if(Test-Path -LiteralPath $f){Get-ChildItem -LiteralPath $f -Filter '*.lnk'|ForEach-Object {$link=$s.CreateShortcut($_.FullName);if($link.Description -eq 'codex-phone managed companion' -and $link.Arguments.Contains($stateArg)){Remove-Item -LiteralPath $_.FullName}}}`,
    );
  const loaded = await readJSON(join(dir, "config.json"), null);
  if (loaded?.deviceId !== config.deviceId)
    throw Error("STATE_OWNERSHIP_CHANGED");
  for (const name of [
    "config.json",
    "phones.json",
    "runtime.json",
    "service.lock",
    "pairing.html",
    "service.log",
    "cloudflared.log",
  ])
    await unlink(join(dir, name)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  for (const name of ["bin", "cloudflare", "upstream-state"]) {
    const target = resolve(dir, name);
    if (!target.startsWith(dir + sep)) throw Error("UNSAFE_UNINSTALL_PATH");
    await rm(target, { recursive: true, force: true });
  }
  output({
    ok: true,
    cloudResourcesRetained: true,
    next: [
      "Cloudflare resources remain in your account; no cloud deletion was performed.",
    ],
  });
});
const relay = cli.command("relay");
relay
  .command("check")
  .action(async () => output(await probeRelay((await ctx()).config)));
const cf = relay.command("cloudflare");
cf.command("deploy")
  .requiredOption("--account <id>")
  .option("--name <name>")
  .option("--namespace <id>")
  .action(async (options) => {
    const { config, dir } = await ctx();
    await requireStopped(config);
    output(await deployCloudflare(config, dir, options));
  });
try {
  await cli.parseAsync();
} catch (e) {
  output({
    ok: false,
    status: "error",
    code: e.code || "operation_failed",
    message: e.message,
    next: e.next || [],
  });
  process.exitCode = 1;
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveJSON, readJSON } from "../src/state.mjs";
import { build } from "esbuild";
import http from "node:http";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
async function fixture(t) {
  const base = await fs.mkdtemp(join(tmpdir(), "codex-phone-cli-contract-"));
  assert(resolve(base).startsWith(resolve(tmpdir())));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(join(base, "tmp"));
  return { base, state: join(base, "state") };
}
function run(f, args) {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "src/cli.mjs"), "--state", f.state, ...args],
      {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          CODEX_PHONE_STATE: f.state,
          CODEX_PHONE_INSTALL_TOKEN: "",
          TEMP: join(f.base, "tmp"),
          TMP: join(f.base, "tmp"),
        },
      },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("isolated CLI timeout"));
    }, 30000);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {}
      done({ code, stdout, stderr, json });
    });
  });
}
test("parser errors honor --json for unknown commands/options and missing arguments", async (t) => {
  const f = await fixture(t);
  for (const [args, code] of [
    [["nonesuch", "--json"], "cli_invalid_command"],
    [["phones", "revoke", "--json"], "cli_missing_argument"],
    [["status", "--does-not-exist", "--json"], "cli_invalid_option"],
    [["setup", "--endpoint", "--json"], "cli_missing_option_value"],
  ]) {
    const result = await run(f, args);
    assert.equal(result.code, 1);
    assert.equal(result.json?.status, "error", result.stdout + result.stderr);
    assert.equal(result.json.code, code);
    assert(result.json.next.length);
    assert.equal(result.stderr, "");
  }
  await assert.rejects(fs.access(f.state), { code: "ENOENT" });
});
test("normal help/version retain successful text output without creating state", async (t) => {
  const f = await fixture(t);
  const help = await run(f, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: codex-phone/);
  assert(!help.json);
  const version = await run(f, ["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  await assert.rejects(fs.access(f.state), { code: "ENOENT" });
});
test("CLI setup is idempotent and an offline status is structured user action", async (t) => {
  const f = await fixture(t);
  const first = await run(f, ["setup", "--no-shortcuts", "--json"]);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const original = await readJSON(join(f.state, "config.json"));
  const second = await run(f, ["setup", "--no-shortcuts", "--json"]);
  assert.equal(second.code, 0);
  assert.equal(second.json.deviceId, first.json.deviceId);
  assert.equal(
    (await readJSON(join(f.state, "config.json"))).adminSecret,
    original.adminSecret,
  );
  const status = await run(f, ["status", "--json"]);
  assert.equal(status.code, 2);
  assert.equal(status.json.status, "needs_user_action");
  assert.equal(status.json.code, "service_not_running");
});
test("an old CLI routes to the verified active generation without starting a real service", async (t) => {
  const f = await fixture(t);
  const generation = join(f.state, "install/generations/fixture");
  await fs.mkdir(join(generation, "dist"), { recursive: true });
  await saveJSON(join(f.state, "config.json"), {
    application: "codex-phone",
    schema: 1,
    deviceId: "cli-fixture",
  });
  await saveJSON(join(generation, ".codex-phone-generation.json"), {
    application: "codex-phone",
    schema: 1,
    deviceId: "cli-fixture",
    generationId: "fixture",
    ready: true,
  });
  await fs.writeFile(
    join(generation, "dist/cli.mjs"),
    'console.log(JSON.stringify({status:"ok",forwarded:true,args:process.argv.slice(2)}));',
  );
  await saveJSON(join(f.state, "install/active.json"), {
    schema: 1,
    root: generation,
    deviceId: "cli-fixture",
    generationId: "fixture",
    bootstrapRoot: root,
  });
  const result = await run(f, ["status", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.forwarded, true);
  assert(result.json.args.includes("status"));
});
test("unverified outside-code pointers are rejected instead of executed", async (t) => {
  const f = await fixture(t);
  const arbitrary = join(f.base, "arbitrary");
  await fs.mkdir(join(arbitrary, "dist"), { recursive: true });
  const executed = join(f.base, "must-not-exist");
  await fs.writeFile(
    join(arbitrary, "dist/cli.mjs"),
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(executed)},'executed');`,
  );
  await saveJSON(join(f.state, "config.json"), {
    application: "codex-phone",
    schema: 1,
    deviceId: "cli-fixture",
  });
  await saveJSON(join(f.state, "install/active.json"), {
    schema: 1,
    root: arbitrary,
    deviceId: "cli-fixture",
    generationId: "outside",
  });
  const result = await run(f, ["status", "--json"]);
  assert.equal(result.code, 1);
  assert.equal(result.json.code, "installation_pointer_invalid");
  await assert.rejects(fs.access(executed), { code: "ENOENT" });
});
test("clean and cached bundled CLI help perform no setup or download side effects", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(join(root, ".cache"), { recursive: true });
  const code = await fs.mkdtemp(join(root, ".cache/cli-contract-build-"));
  assert(resolve(code).startsWith(join(root, ".cache")));
  t.after(() => fs.rm(code, { recursive: true, force: true }));
  await fs.mkdir(join(code, "dist"));
  const pkg = await readJSON(join(root, "package.json"));
  await saveJSON(join(code, "package.json"), {
    name: "codex-phone",
    version: pkg.version,
  });
  await fs.copyFile(
    join(root, "upstream.lock.json"),
    join(code, "upstream.lock.json"),
  );
  await build({
    entryPoints: [join(root, "src/cli.mjs")],
    outfile: join(code, "dist/cli.mjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    packages: "external",
  });
  let proxyRequests = 0;
  const proxy = http.createServer((_req, res) => {
    proxyRequests++;
    res.writeHead(502);
    res.end();
  });
  proxy.on("connect", (_req, socket) => {
    proxyRequests++;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const proxyURL = `http://127.0.0.1:${proxy.address().port}`;
  const invoke = () =>
    new Promise((done, reject) => {
      const child = spawn(
        process.execPath,
        [join(code, "dist/cli.mjs"), "--state", f.state, "--help"],
        {
          windowsHide: true,
          env: {
            ...process.env,
            CODEX_PHONE_STATE: f.state,
            HTTP_PROXY: proxyURL,
            HTTPS_PROXY: proxyURL,
            http_proxy: proxyURL,
            https_proxy: proxyURL,
            NO_PROXY: "",
            no_proxy: "",
          },
        },
      );
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(
          Error(
            "Bundled help timed out; no network/bootstrap work is permitted.",
          ),
        );
      }, 15000);
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exit) => {
        clearTimeout(timer);
        done({ exit, stdout, stderr });
      });
    });
  const result = await invoke();
  assert.equal(result.exit, 0, result.stderr);
  assert.match(result.stdout, /Usage: codex-phone/);
  assert.equal(proxyRequests, 0);
  await assert.rejects(fs.access(join(code, ".cache")), { code: "ENOENT" });
  await fs.mkdir(join(code, ".cache"));
  await fs.writeFile(join(code, ".cache/sentinel"), "preserve");
  const cached = await invoke();
  assert.equal(cached.exit, 0, cached.stderr);
  assert.equal(proxyRequests, 0);
  assert.deepEqual(await fs.readdir(join(code, ".cache")), ["sentinel"]);
  await assert.rejects(fs.access(f.state), { code: "ENOENT" });
});

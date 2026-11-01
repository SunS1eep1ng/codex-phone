import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import https from "node:https";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { httpsOrigin, saveJSON, secret, PhoneError } from "./state.mjs";
import { downloadVerified, lock } from "../scripts/prepare-upstream.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
async function remoteFetch(url, options = {}, proxy = "") {
  if (!proxy)
    return fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(12000),
    });
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers,
        agent: new HttpsProxyAgent(proxy),
        signal: options.signal || AbortSignal.timeout(12000),
      },
      (res) => {
        const data = [];
        let length = 0;
        res.on("data", (b) => {
          length += b.length;
          if (length > 1024 * 1024) {
            req.destroy(Error("RELAY_RESPONSE_TOO_LARGE"));
            return;
          }
          data.push(b);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(data), {
              status: res.statusCode,
              headers: res.headers,
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}
export async function rejectsAnonymousWS(endpoint, proxy = "") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      endpoint.replace(/^https:/, "wss:") + "/codex-api/ws",
      {
        handshakeTimeout: 12000,
        ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
      },
    );
    ws.once("open", () => {
      ws.close();
      reject(Error("unauthenticated_websocket_accepted"));
    });
    ws.once("unexpected-response", (_r, res) => {
      res.resume();
      ws.terminate();
      res.statusCode === 401
        ? resolve(true)
        : reject(Error("websocket_rejection_" + res.statusCode));
    });
    ws.once("error", reject);
  });
}
export async function probeRelay(config) {
  if (!config.relay.endpoint)
    return {
      ok: false,
      code: "relay_not_configured",
      next: ["Configure Cloudflare or a provided HTTPS endpoint."],
    };
  try {
    const url = httpsOrigin(config.relay.endpoint);
    const r = await remoteFetch(url + "/phone-api/info", {}, config.proxy);
    const info = await r.json();
    if (!r.ok || info.deviceId !== config.deviceId)
      throw Error("wrong_computer");
    const rejection = await remoteFetch(
      url + "/codex-api/rpc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      config.proxy,
    );
    if (rejection.status !== 401) throw Error("authentication_boundary_failed");
    await rejectsAnonymousWS(url, config.proxy);
    return {
      ok: true,
      identity: true,
      unauthenticatedHTTPRejected: true,
      unauthenticatedWSRejected: true,
      endpoint: url,
    };
  } catch (e) {
    return {
      ok: false,
      code: "relay_unavailable",
      message: e.message,
      next: [
        "Check DNS/TLS, tunnel registration and endpoint forwarding; do not change system DNS automatically.",
      ],
    };
  }
}
export class ProvidedRelay {
  constructor(config) {
    this.config = config;
  }
  async configure(endpoint) {
    this.config.relay = {
      provider: "provided",
      endpoint: httpsOrigin(endpoint),
    };
  }
  async start() {
    return { ok: true, externallyManaged: true };
  }
  async stop() {}
  async health() {
    return probeRelay(this.config);
  }
}
export class CloudflareRelay {
  constructor(config, dir) {
    this.config = config;
    this.dir = dir;
    this.child = null;
    this.origin = "";
    this.stopped = false;
    this.error = null;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.startInner();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }
  async startInner() {
    this.stopped = false;
    const cf = this.config.relay;
    if (!cf.registrationSecret || !cf.endpoint)
      throw new PhoneError("cloudflare_not_deployed");
    if (process.platform !== "win32" || process.arch !== "x64")
      throw new PhoneError("unsupported_tunnel_platform");
    const exe = await downloadVerified(
      lock.cloudflared["windows-x64"],
      join(this.dir, "bin/cloudflared.exe"),
    );
    const logfile = join(this.dir, "cloudflared.log");
    await writeFile(logfile, "");
    const env = {
      ...process.env,
      ...(this.config.proxy
        ? { HTTP_PROXY: this.config.proxy, HTTPS_PROXY: this.config.proxy }
        : {}),
    };
    if (this.stopped) return;
    const child = spawn(
      exe,
      [
        "tunnel",
        "--no-autoupdate",
        "--logfile",
        logfile,
        "--url",
        `http://127.0.0.1:${this.config.ports.gateway}`,
      ],
      { stdio: "ignore", windowsHide: true, env },
    );
    this.child = child;
    child.on("error", (e) => {
      this.error = e.message;
      if (this.child === child) this.child = null;
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.timer = setInterval(
      () =>
        void this.tick(logfile).catch((e) => {
          this.error = e.message;
        }),
      4000,
    );
    await this.tick(logfile);
  }
  async tick(logfile) {
    if (this.stopped) return;
    if (!this.child) {
      clearInterval(this.timer);
      return this.start();
    }
    const text = await readFile(logfile, "utf8").catch(() => "");
    const origins = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    const origin = origins?.at(-1);
    if (!origin) return;
    if (origin === this.origin) return;
    if (this.registering) return;
    this.registering = true;
    try {
      const response = await remoteFetch(
        this.config.relay.endpoint + "/_bridge/register",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + this.config.relay.registrationSecret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ deviceId: this.config.deviceId, origin }),
          signal: AbortSignal.timeout(10000),
        },
        this.config.proxy,
      );
      if (!response.ok)
        throw Error("TUNNEL_REGISTRATION_FAILED: " + response.status);
      this.origin = origin;
      this.error = null;
    } finally {
      this.registering = false;
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.child?.kill();
    this.child = null;
  }
  async health() {
    return {
      ...(await probeRelay(this.config)),
      provider: "cloudflare",
      tunnelProcess: !!this.child,
      registered: !!this.origin,
      error: this.error,
    };
  }
}
export function runTool(
  executable,
  args,
  { cwd = root, input, env = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const p = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(Error("CHILD_TIMEOUT"));
    }, 180000);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(out)
        : reject(Error("CHILD_EXIT_" + code + ": " + err.slice(-1800)));
    });
    p.stdin.end(input);
  });
}
export async function deployCloudflare(
  config,
  dir,
  { account, name, namespace },
) {
  if (!/^[a-f0-9]{32}$/.test(account || ""))
    throw new PhoneError(
      "cloudflare_account_required",
      "Provide your Cloudflare account ID.",
      ["Run npx wrangler whoami; authorize with npx wrangler login first."],
    );
  const work = join(dir, "cloudflare");
  await mkdir(work, { recursive: true });
  const script = join(root, "src/worker-template.mjs");
  const cf = config.relay.provider === "cloudflare" ? config.relay : {};
  cf.provider = "cloudflare";
  cf.accountId = account;
  cf.name = name || cf.name || "codex-phone-" + config.deviceId.slice(0, 8);
  cf.registrationSecret ||= secret();
  if (!/^[a-z0-9-]{3,63}$/.test(cf.name)) throw Error("INVALID_WORKER_NAME");
  const path = join(work, "wrangler.json");
  const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
  const args = ["--config", path];
  const write = () =>
    saveJSON(path, {
      name: cf.name,
      main: script,
      account_id: account,
      compatibility_date: "2026-10-30",
      workers_dev: true,
      vars: { DEVICE_ID: config.deviceId },
      ...(cf.namespaceId
        ? {
            kv_namespaces: [
              { binding: "DESKTOP_ENDPOINTS", id: cf.namespaceId },
            ],
          }
        : {}),
    });
  await write();
  cf.namespaceId = namespace || cf.namespaceId;
  if (!cf.namespaceId) {
    const output = await runTool(process.execPath, [
      wrangler,
      "kv",
      "namespace",
      "create",
      "DESKTOP_ENDPOINTS",
      ...args,
    ]);
    cf.namespaceId =
      /"id"\s*:\s*"([a-f0-9]{32})"/.exec(output)?.[1] ||
      /id\s*=\s*"([a-f0-9]{32})"/.exec(output)?.[1];
    if (!cf.namespaceId) throw Error("KV_ID_NOT_FOUND");
    await write();
  }
  await write();
  config.relay = cf;
  await saveJSON(join(dir, "config.json"), config);
  const output = await runTool(process.execPath, [wrangler, "deploy", ...args]);
  cf.endpoint =
    /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0] || cf.endpoint;
  if (!cf.endpoint) throw Error("WORKER_URL_NOT_FOUND");
  await runTool(
    process.execPath,
    [wrangler, "secret", "put", "REGISTRATION_SECRET", ...args],
    { input: cf.registrationSecret + "\n" },
  );
  await saveJSON(join(dir, "config.json"), config);
  return {
    ok: true,
    endpoint: cf.endpoint,
    next: ["Start the companion and run doctor before pairing."],
  };
}

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
  constructor(config, dir, dependencies = {}) {
    this.config = config;
    this.dir = dir;
    this.dependencies = {
      download: downloadVerified,
      spawnProcess: spawn,
      register: remoteFetch,
      readLog: readFile,
      writeLog: writeFile,
      setInterval,
      clearInterval,
      platform: process.platform,
      arch: process.arch,
      monitorIntervalMs: 4000,
      stopTimeoutMs: 1500,
      probe: probeRelay,
      now: Date.now,
      restartBackoffMs: 8000,
      restartMaxBackoffMs: 60000,
      ...dependencies,
    };
    this.child = null;
    this.origin = "";
    this.stopped = false;
    this.error = null;
    this.timer = null;
    this.starting = null;
    this.stopping = null;
    this.generation = 0;
    this.epoch = (config.deviceId || "local") + ":tunnel:0";
    this.registration = null;
    this.startAbort = null;
    this.recovering = null;
    this.nextStartAt = 0;
    this.invalidations = 0;
    this.logfile = join(dir, "cloudflared.log");
  }
  current(generation, child) {
    return (
      !this.stopped &&
      generation === this.generation &&
      (!child || this.child === child)
    );
  }
  ensureMonitor() {
    if (this.timer !== null) return;
    this.timer = this.dependencies.setInterval(() => {
      if (this.stopped) return;
      const work = this.child
        ? this.tick(this.logfile, this.generation)
        : this.start();
      void work.catch((error) => {
        if (!this.stopped) this.error = error.message;
      });
    }, this.dependencies.monitorIntervalMs);
    this.timer.unref?.();
  }
  async start() {
    if (this.stopping)
      throw new PhoneError(
        "relay_stopping",
        "Relay is still stopping; retry after it stops.",
      );
    if (this.starting) return this.starting;
    if (this.child) return;
    if (this.dependencies.now() < this.nextStartAt) return;
    const cf = this.config.relay;
    if (!cf.registrationSecret || !cf.endpoint)
      throw new PhoneError("cloudflare_not_deployed");
    if (
      this.dependencies.platform !== "win32" ||
      this.dependencies.arch !== "x64"
    )
      throw new PhoneError("unsupported_tunnel_platform");
    this.stopped = false;
    this.ensureMonitor();
    const generation = ++this.generation;
    this.epoch = (this.config.deviceId || "local") + ":tunnel:" + generation;
    this.origin = "";
    this.startAbort = new AbortController();
    const promise = this.startInner(generation, this.startAbort.signal);
    this.starting = promise;
    try {
      return await promise;
    } catch (error) {
      if (this.current(generation)) {
        this.error = error.message;
        throw error;
      }
    } finally {
      if (this.starting === promise) {
        this.starting = null;
        this.startAbort = null;
      }
    }
  }
  async startInner(generation, signal) {
    const exe = await this.dependencies.download(
      lock.cloudflared["windows-x64"],
      join(this.dir, "bin/cloudflared.exe"),
      { signal },
    );
    if (!this.current(generation) || signal.aborted) return;
    await this.dependencies.writeLog(this.logfile, "");
    if (!this.current(generation) || signal.aborted) return;
    const env = {
      ...process.env,
      ...(this.config.proxy
        ? { HTTP_PROXY: this.config.proxy, HTTPS_PROXY: this.config.proxy }
        : {}),
    };
    const child = this.dependencies.spawnProcess(
      exe,
      [
        "tunnel",
        "--no-autoupdate",
        "--logfile",
        this.logfile,
        "--url",
        `http://127.0.0.1:${this.config.ports.gateway}`,
      ],
      { stdio: "ignore", windowsHide: true, env },
    );
    this.child = child;
    this.error = null;
    const lost = (error) => {
      if (!this.current(generation, child)) return;
      this.child = null;
      this.origin = "";
      this.error =
        error?.message || "Tunnel child exited; waiting for recovery.";
      ++this.generation;
      this.epoch =
        (this.config.deviceId || "local") + ":tunnel:" + this.generation;
      this.startAbort?.abort();
      this.startAbort = null;
      this.starting = null;
      this.registration?.controller.abort();
      this.registration = null;
    };
    child.on("error", lost);
    child.on("exit", () => lost());
    await this.tick(this.logfile, generation);
  }
  async tick(logfile = this.logfile, generation = this.generation) {
    if (!this.current(generation)) return;
    if (!this.child) return this.start();
    const child = this.child;
    let text;
    try {
      text = await this.dependencies.readLog(logfile, "utf8");
    } catch (error) {
      if (this.current(generation, child))
        this.error = "TUNNEL_LOG_READ_FAILED: " + error.code;
      return;
    }
    if (!this.current(generation, child)) return;
    // Quick Tunnels can be invalidated while cloudflared remains alive and
    // retries forever. A fresh tunnel is required after this terminal rejection.
    const log = String(text || "");
    const invalidated = log.lastIndexOf("Unauthorized: Tunnel not found");
    if (
      invalidated >= 0 &&
      invalidated > log.lastIndexOf("Registered tunnel connection")
    ) {
      return this.retireInvalidatedChild(generation, child);
    }
    const origin = String(text || "")
      .match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)
      ?.at(-1);
    if (!origin || origin === this.origin) return;
    if (this.registration?.generation === generation)
      return this.registration.promise;
    const registration = {
      generation,
      controller: new AbortController(),
      promise: null,
    };
    this.registration = registration;
    registration.promise = (async () => {
      try {
        const response = await this.dependencies.register(
          this.config.relay.endpoint + "/_bridge/register",
          {
            method: "POST",
            headers: {
              authorization: "Bearer " + this.config.relay.registrationSecret,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ deviceId: this.config.deviceId, origin }),
            signal: AbortSignal.any([
              registration.controller.signal,
              AbortSignal.timeout(10000),
            ]),
          },
          this.config.proxy,
        );
        if (
          !this.current(generation, child) ||
          registration.controller.signal.aborted
        )
          return;
        if (!response.ok)
          throw Error("TUNNEL_REGISTRATION_FAILED: " + response.status);
        this.origin = origin;
        this.error = null;
      } catch (error) {
        if (
          this.current(generation, child) &&
          !registration.controller.signal.aborted
        ) {
          this.error = error.message;
          throw error;
        }
      } finally {
        if (this.registration === registration) this.registration = null;
      }
    })();
    return registration.promise;
  }
  async retireInvalidatedChild(generation, child) {
    if (!this.current(generation, child)) return;
    if (this.recovering) return this.recovering;
    const retiredGeneration = ++this.generation;
    this.epoch =
      (this.config.deviceId || "local") + ":tunnel:" + retiredGeneration;
    this.origin = "";
    this.error =
      "TUNNEL_INVALIDATED: Cloudflare rejected the live tunnel; waiting to create a fresh tunnel.";
    this.registration?.controller.abort();
    this.registration = null;
    const recovering = (async () => {
      await this.stopChild(child);
      if (!this.current(retiredGeneration, child)) return;
      if (child.exitCode === null || child.exitCode === undefined) {
        this.error = "TUNNEL_STOP_FAILED: invalidated tunnel has not exited.";
        return;
      }
      this.child = null;
      this.nextStartAt =
        this.dependencies.now() +
        Math.min(
          this.dependencies.restartMaxBackoffMs,
          this.dependencies.restartBackoffMs *
            2 ** Math.min(this.invalidations++, 8),
        );
    })();
    this.recovering = recovering;
    try {
      await recovering;
    } finally {
      if (this.recovering === recovering) this.recovering = null;
    }
  }
  async stopChild(child) {
    if (!child) return;
    await new Promise((resolve) => {
      let timer,
        finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.off?.("exit", done);
        child.off?.("close", done);
        resolve();
      };
      child.once?.("exit", done);
      child.once?.("close", done);
      timer = setTimeout(() => {
        try {
          if (child.kill("SIGKILL") === false && child.exitCode === null)
            this.error =
              "TUNNEL_STOP_FAILED: owned child did not acknowledge termination.";
        } catch (error) {
          this.error = "TUNNEL_STOP_FAILED: " + error.message;
        }
        done();
      }, this.dependencies.stopTimeoutMs);
      try {
        if (child.exitCode !== null && child.exitCode !== undefined) done();
        else child.kill();
      } catch (error) {
        this.error = "TUNNEL_STOP_FAILED: " + error.message;
        done();
      }
    });
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.nextStartAt = 0;
    this.invalidations = 0;
    ++this.generation;
    this.epoch =
      (this.config.deviceId || "local") + ":tunnel:" + this.generation;
    if (this.timer !== null) this.dependencies.clearInterval(this.timer);
    this.timer = null;
    const pending = this.starting;
    this.starting = null;
    this.startAbort?.abort();
    this.startAbort = null;
    const registration = this.registration;
    this.registration = null;
    registration?.controller.abort();
    const child = this.child;
    this.child = null;
    this.origin = "";
    const waitBounded = (promise) => {
      let timer;
      return Promise.race([
        Promise.resolve(promise).catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.dependencies.stopTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    };
    const stopping = (async () => {
      await this.stopChild(child);
      await Promise.all([
        waitBounded(pending),
        waitBounded(registration?.promise),
      ]);
    })();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = null;
    }
  }
  async health() {
    const result = await this.dependencies.probe(this.config);
    const registered = !!this.child && !!this.origin;
    return {
      ...result,
      ok: result.ok && registered,
      provider: "cloudflare",
      tunnelProcess: !!this.child,
      registered,
      error: this.error,
      epoch: this.epoch,
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

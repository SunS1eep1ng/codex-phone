import { createServer } from "node:http";
import { open, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PhoneAuth } from "./auth.mjs";
import { saveJSON, readJSON, PhoneError } from "./state.mjs";
import { NativeDriver } from "./native.mjs";
import { LocalAgent } from "./agent.mjs";
import { createGateway, createControl, listen } from "./gateway.mjs";
import { ensureDesktop, verifyDesktopPort } from "./windows.mjs";
import { CloudflareRelay, ProvidedRelay } from "./relay.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export async function control(config, name, body) {
  if (!config.ports.control) throw new PhoneError("service_not_running");
  const r = await fetch(`http://127.0.0.1:${config.ports.control}/${name}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: "Bearer " + config.adminSecret,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000),
  });
  const result = await r.json();
  if (!r.ok) throw new PhoneError(result.error || "control_failed");
  return result;
}
export async function serve(config, dir, dependencies = {}) {
  const lockPath = join(dir, "service.lock");
  let lease;
  try {
    lease = await open(lockPath, "wx", 0o600);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const previous = await readJSON(lockPath, {});
    let alive = false;
    try {
      process.kill(previous.pid, 0);
      alive = true;
    } catch {}
    if (alive)
      throw new PhoneError(
        "service_already_starting",
        "An owned service lease is active.",
      );
    await unlink(lockPath);
    lease = await open(lockPath, "wx", 0o600);
  }
  await lease.writeFile(
    JSON.stringify({ pid: process.pid, deviceId: config.deviceId }),
  );
  let gateway,
    admin,
    upstream,
    agent,
    driver,
    relay,
    timer,
    stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    agent?.stop();
    await driver?.close();
    await relay?.stop();
    gateway?.close();
    admin?.closeAllConnections();
    admin?.close();
    upstream?.dispose();
    await lease.close();
    await unlink(lockPath).catch(() => {});
    await unlink(join(dir, "runtime.json")).catch(() => {});
  };
  try {
    process.env.CODEXUI_DESKTOP_DRIVER = "agent";
    process.env.CODEXUI_AGENT_PAIRING_TOKEN = config.agentSecret;
    process.env.CODEXUI_AGENT_DEVICE_ID = config.deviceId;
    process.env.CODEX_HOME = join(dir, "upstream-state");
    const module =
      dependencies.upstreamModule ||
      (await import(
        pathToFileURL(join(root, "dist/upstream/dist-cli/server.mjs"))
      ));
    upstream = module.createServer();
    const auth = await PhoneAuth.open(config, dir);
    let desktop = { ok: false, code: "desktop_starting" };
    driver =
      dependencies.driver ||
      new NativeDriver({
        port: config.ports.desktop,
        verify: verifyDesktopPort,
      });
    relay =
      dependencies.relay ||
      (config.relay.provider === "cloudflare"
        ? new CloudflareRelay(config, dir)
        : new ProvidedRelay(config));
    const status = () => ({
      ok: true,
      deviceId: config.deviceId,
      pid: process.pid,
      desktop,
      driver: { state: driver.state, error: driver.error },
      relay: {
        provider: config.relay.provider,
        endpoint: config.relay.endpoint,
      },
    });
    admin = createControl({
      config,
      upstream,
      actions: async (name, body) => {
        if (name === "status") return status();
        if (name === "doctor") {
          const native = await driver.health(),
            network = await relay.health();
          return {
            ok: native.ok && network.ok,
            code: native.ok
              ? network.ok
                ? "ready"
                : "relay_unavailable"
              : "desktop_unavailable",
            desktop: native,
            relay: network,
            authentication: {
              httpAndWS: true,
              authorizedPhones: auth.list().filter((p) => !p.revokedAt).length,
            },
          };
        }
        if (name === "pair")
          return {
            ...(await auth.pairCode()),
            deviceId: config.deviceId,
            deviceName: config.deviceName,
            endpoint: config.relay.endpoint,
          };
        if (name === "phones") return { phones: auth.list() };
        if (name === "revoke") {
          await auth.revoke(body.phoneId);
          return { ok: true };
        }
        if (name === "stop") {
          setTimeout(() => void cleanup().then(() => process.exit(0)), 100);
          return { ok: true };
        }
      },
    });
    try {
      config.ports.control = await listen(admin, config.ports.control);
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      config.ports.control = await listen(admin, 0);
    }
    gateway = createGateway({
      config,
      auth,
      upstream,
      health: () => driver.health(),
      nativeRPC: (method, params) => driver.rpc(method, params),
      apkPath: join(root, "release/codex-phone-v0.1.0.apk"),
    });
    try {
      config.ports.gateway = await listen(gateway.server, config.ports.gateway);
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      config.ports.gateway = await listen(gateway.server, 0);
    }
    await saveJSON(join(dir, "config.json"), config);
    await saveJSON(join(dir, "runtime.json"), {
      pid: process.pid,
      deviceId: config.deviceId,
      startedAt: new Date().toISOString(),
    });
    agent = new LocalAgent(config, driver);
    agent.start(config.ports.control);
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || stopping) return;
      refreshing = true;
      try {
        desktop = await (dependencies.ensureDesktop || ensureDesktop)(config);
        if (stopping) return;
        if (desktop.ok && driver.port !== config.ports.desktop) {
          await driver.close();
          driver.port = config.ports.desktop;
          await saveJSON(join(dir, "config.json"), config);
        }
        if (desktop.ok) await driver.connect().catch(() => {});
        if (
          !stopping &&
          config.relay.provider === "cloudflare" &&
          !relay.child &&
          !relay.starting
        )
          void relay
            .start()
            .catch((e) => console.error("Relay:", e.code || e.message));
      } catch (e) {
        desktop = {
          ok: false,
          code: e.code || "desktop_unavailable",
          message: e.message,
        };
      } finally {
        refreshing = false;
      }
    };
    timer = setInterval(
      () => void refresh(),
      dependencies.refreshInterval || 5000,
    );
    void refresh();
    void relay
      .start()
      .catch((e) => console.error("Relay:", e.code || e.message));
    process.once("SIGTERM", () => void cleanup().then(() => process.exit(0)));
    process.once("SIGINT", () => void cleanup().then(() => process.exit(0)));
    console.log(
      "codex-phone service started; native thread/list must pass doctor before acceptance.",
    );
    return { cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

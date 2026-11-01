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
import { randomUUID } from "node:crypto";
import { requestControl } from "./control-auth.mjs";
import { OperationJournal } from "./operations.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const project = await readJSON(join(root, "package.json"), {
  version: "0.1.1",
});
export const control = requestControl;
export async function serve(config, dir, dependencies = {}) {
  const supervisedStart =
    dependencies.supervisedStart ??
    process.env.CODEX_PHONE_SUPERVISOR_START === "1";
  const checkStartAllowed = async () => {
    if (!supervisedStart) return;
    const marker = await readJSON(join(dir, "supervisor-stop.json"), null);
    if (
      marker?.application === "codex-phone-supervisor-stop" &&
      marker.deviceId === config.deviceId
    )
      throw new PhoneError(
        "supervisor_start_cancelled",
        "An explicit stop cancelled the pending companion recovery.",
      );
  };
  await checkStartAllowed();
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
    journal,
    refreshPromise,
    cleanupPromise,
    stopping = false;
  const lifetime = new AbortController();
  const instanceId = randomUUID();
  let recoveryGeneration = 0;
  const epoch = () =>
    `${instanceId}:${recoveryGeneration}:${driver?.epoch || "initial"}`;
  const advanceEpoch = () => {
    recoveryGeneration++;
  };
  const exit = dependencies.exit || ((code) => process.exit(code));
  const onSignal = () => void cleanup().then(() => exit(0));
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    stopping = true;
    lifetime.abort();
    advanceEpoch();
    clearInterval(timer);
    cleanupPromise = (async () => {
      agent?.stop();
      await journal
        ?.suspend()
        .catch((e) =>
          console.error("Operation state:", e.code || "save_failed"),
        );
      await Promise.allSettled([driver?.close(), relay?.stop()]);
      driver?.off?.("disconnect", advanceEpoch);
      try {
        upstream?.dispose();
      } catch {}
      admin?.closeOwnedSockets?.();
      const adminClosed = admin?.listening
        ? new Promise((resolve) => admin.close(resolve))
        : Promise.resolve();
      admin?.closeAllConnections();
      await Promise.allSettled([gateway?.close(), adminClosed]);
      await journal?.queue;
      await lease.close();
      await unlink(lockPath).catch(() => {});
      await unlink(join(dir, "runtime.json")).catch(() => {});
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    })();
    return cleanupPromise;
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
    await checkStartAllowed();
    const auth = await PhoneAuth.open(config, dir);
    journal = await OperationJournal.open(config, dir);
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
    const agentAvailable = () => agent?.connected === true;
    const connection = () => ({
      state: stopping ? "stopping" : driver?.state || "disconnected",
      nativeReady: !stopping && driver?.state === "ready" && agentAvailable(),
      agentConnected: agentAvailable(),
    });
    let lastHealth = null,
      healthAt = 0,
      healthCacheEpoch = null,
      healthPromise = null;
    const health = async () => {
      if (stopping) return { ok: false, state: "stopping", epoch: epoch() };
      const observedEpoch = epoch();
      if (driver.state !== "ready") {
        healthAt = 0;
        lastHealth = null;
      }
      if (
        !healthPromise &&
        (Date.now() - healthAt > 2000 || healthCacheEpoch !== observedEpoch)
      ) {
        const probeEpoch = observedEpoch;
        healthPromise = driver
          .health()
          .then((value) => {
            lastHealth = value;
            healthCacheEpoch = probeEpoch;
            healthAt = probeEpoch === epoch() ? Date.now() : 0;
            return value;
          })
          .finally(() => {
            healthPromise = null;
          });
      }
      const native = healthPromise
        ? await healthPromise
        : lastHealth || { ok: false, state: driver.state };
      return {
        ...native,
        ok:
          native.ok === true &&
          agentAvailable() &&
          driver.state === "ready" &&
          observedEpoch === epoch() &&
          healthCacheEpoch === epoch(),
        state:
          native.ok &&
          agentAvailable() &&
          driver.state === "ready" &&
          observedEpoch === epoch() &&
          healthCacheEpoch === epoch()
            ? "ready"
            : driver.state || "disconnected",
        nativeThreadList:
          native.ok === true &&
          driver.state === "ready" &&
          observedEpoch === epoch() &&
          healthCacheEpoch === epoch(),
        agentConnected: agentAvailable(),
        epoch: epoch(),
      };
    };
    const recovery = async (threadId, { probe = false } = {}) => {
      if (threadId && !/^[A-Za-z0-9._:-]{1,128}$/.test(threadId))
        return {
          ok: false,
          code: "thread_id_invalid",
          epoch: epoch(),
          connection: connection(),
          uncertainOperations: journal.list(),
        };
      const before = epoch(),
        native = await health();
      const base = {
        ok: native.ok,
        epoch: epoch(),
        connection: { ...connection(), nativeReady: native.ok },
        threadId,
        pendingApprovals: [],
        uncertainOperations: journal.list(threadId),
      };
      if (!native.ok) return { ...base, code: "desktop_unavailable" };
      if (probe) return base;
      const [pending, history] = await Promise.allSettled([
        driver.rpc("codex-web/local/server-requests/pending", null),
        threadId
          ? driver.rpc("thread/read", { threadId, includeTurns: true })
          : Promise.resolve(null),
      ]);
      if (stopping || before !== epoch())
        return {
          ...base,
          ok: false,
          epoch: epoch(),
          connection: connection(),
          code: "snapshot_stale",
        };
      if (pending.status === "rejected" || history.status === "rejected")
        return { ...base, ok: false, code: "snapshot_unavailable" };
      if (
        !Array.isArray(pending.value) ||
        (threadId && !Array.isArray(history.value?.thread?.turns))
      )
        return { ...base, ok: false, code: "snapshot_invalid" };
      return {
        ...base,
        pendingApprovals: pending.value,
        thread: history.value?.thread || null,
        threadTurnStartIndex: history.value?.threadTurnStartIndex || 0,
      };
    };
    const status = () => ({
      ok: true,
      deviceId: config.deviceId,
      pid: process.pid,
      instanceId,
      codeRoot: root,
      epoch: epoch(),
      connection: connection(),
      unresolvedOperations: journal.list().length,
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
          const native = await health(),
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
          setTimeout(() => void cleanup().then(() => exit(0)), 100);
          return { ok: true };
        }
      },
    });
    await checkStartAllowed();
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
      health,
      recovery,
      acknowledgeOperation: (id) => journal.acknowledge(id),
      staticAssets: {
        "/phone-recovery.js": {
          path: join(root, "dist/upstream/dist/phone-recovery.js"),
          cacheable: true,
          cacheControl: "public, max-age=300",
        },
        "/sw.js": { path: join(root, "dist/upstream/dist/sw.js") },
      },
      nativeRPC: (method, params) => driver.rpc(method, params),
      apkPath: join(root, `release/codex-phone-v${project.version}.apk`),
    });
    try {
      config.ports.gateway = await listen(gateway.server, config.ports.gateway);
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      config.ports.gateway = await listen(gateway.server, 0);
    }
    await saveJSON(join(dir, "config.json"), config);
    await checkStartAllowed();
    await saveJSON(join(dir, "runtime.json"), {
      pid: process.pid,
      deviceId: config.deviceId,
      startedAt: new Date().toISOString(),
    });
    const agentDriver = {
      on: (...args) => driver.on(...args),
      off: (...args) => driver.off(...args),
      health: () =>
        stopping
          ? Promise.resolve({ ok: false, state: "stopping" })
          : driver.health(),
      rpc: (method, params, options) => {
        if (stopping) return Promise.reject(new PhoneError("service_stopping"));
        return journal.run(
          method,
          params,
          () => {
            if (stopping) throw new PhoneError("service_stopping");
            return driver.rpc(method, params);
          },
          options,
        );
      },
      get epoch() {
        return driver.epoch;
      },
      get state() {
        return driver.state;
      },
    };
    agent = new LocalAgent(
      { ...config, projectVersion: project.version },
      agentDriver,
    );
    agent.on("resync", () => {
      advanceEpoch();
      healthAt = 0;
    });
    agent.on("resync-needed", advanceEpoch);
    agent.on("disconnect", advanceEpoch);
    driver.on("disconnect", advanceEpoch);
    agent.start(config.ports.control);
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || stopping) return;
      refreshing = true;
      try {
        await checkStartAllowed();
        desktop = await (dependencies.ensureDesktop || ensureDesktop)(config, {
          signal: lifetime.signal,
          checkCancelled: checkStartAllowed,
        });
        await checkStartAllowed();
        if (stopping) return;
        if (desktop.ok && driver.port !== config.ports.desktop) {
          await driver.close();
          if (stopping) return;
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
        if (e.code === "supervisor_start_cancelled") {
          void cleanup().then(() => exit(0));
          return;
        }
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
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    console.log(
      "codex-phone service started; native thread/list must pass doctor before acceptance.",
    );
    return { cleanup, recovery, status };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

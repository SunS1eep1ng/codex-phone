import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { serve, control } from "../src/service.mjs";
test("a stop marker fences a detached supervised service before it publishes ports", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codex-phone-start-fence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let desktopCalls = 0,
    disposed = 0;
  const config = {
    deviceId: "fenced-start",
    deviceName: "mock",
    adminSecret: "test-key",
    agentSecret: "test-agent",
    ports: { control: 0, gateway: 0, desktop: 0 },
    relay: { provider: "provided", endpoint: "" },
  };
  const createServer = () => {
    writeFileSync(
      join(dir, "supervisor-stop.json"),
      JSON.stringify({
        application: "codex-phone-supervisor-stop",
        deviceId: config.deviceId,
      }),
    );
    return { dispose: () => disposed++, attachWebSocket() {}, app() {} };
  };
  await assert.rejects(
    serve(config, dir, {
      supervisedStart: true,
      upstreamModule: { createServer },
      ensureDesktop: async () => {
        desktopCalls++;
        return { ok: true };
      },
    }),
    { code: "supervisor_start_cancelled" },
  );
  assert.equal(desktopCalls, 0);
  assert.equal(config.ports.control, 0);
  assert.equal(config.ports.gateway, 0);
  assert.equal(disposed, 1);
  await assert.rejects(access(join(dir, "service.lock")), { code: "ENOENT" });
  await assert.rejects(access(join(dir, "runtime.json")), { code: "ENOENT" });
});

test("recovery checks the current native epoch, refreshes approvals/history and surfaces unknown writes without replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codex-phone-recovery-"));
  const config = {
    deviceId: "recovery-test",
    deviceName: "Mock",
    agentSecret: "synthetic-agent",
    adminSecret: "synthetic-admin",
    ports: { gateway: 0, control: 0, desktop: 0 },
    relay: { provider: "provided", endpoint: "" },
  };
  const driver = new EventEmitter();
  let writes = 0,
    changeDuringRead = false;
  Object.assign(driver, {
    state: "ready",
    epoch: "native-1",
    port: 0,
    connect: async () => {},
    close: async () => {
      driver.state = "disconnected";
      driver.emit("disconnect");
    },
    health: async () => ({ ok: true, nativeThreadList: true }),
    rpc: async (method) => {
      if (method === "codex-web/local/server-requests/pending")
        return [
          {
            id: 7,
            conversationId: "same",
            method: "item/commandExecution/requestApproval",
          },
        ];
      if (method === "thread/read") {
        if (changeDuringRead) {
          changeDuringRead = false;
          driver.epoch = "native-3";
          driver.emit("ready");
        }
        return { thread: { id: "same", turns: [{ id: "native-turn" }] } };
      }
      if (method === "turn/start") {
        writes++;
        throw Object.assign(Error("response lost after dispatch"), {
          code: "native_outcome_unknown",
          outcomeUnknown: true,
        });
      }
      return { data: [] };
    },
  });
  const service = await serve(config, dir, {
    driver,
    relay: {
      start: async () => {},
      stop: async () => {},
      health: async () => ({ ok: true }),
    },
    ensureDesktop: async () => ({ ok: true }),
    refreshInterval: 10000,
  });
  t.after(async () => {
    await service.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 50; i++) {
    if ((await service.status()).connection.agentConnected) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  let snapshot = await service.recovery("same");
  assert(snapshot.ok);
  assert.equal(snapshot.thread.id, "same");
  assert.equal(snapshot.pendingApprovals[0].id, 7);
  const firstEpoch = snapshot.epoch;
  driver.state = "disconnected";
  driver.emit("disconnect");
  snapshot = await service.recovery("same", { probe: true });
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.connection.nativeReady, false);
  assert.notEqual(snapshot.epoch, firstEpoch);
  driver.state = "ready";
  driver.epoch = "native-2";
  driver.emit("ready");
  snapshot = await service.recovery("same");
  assert(snapshot.ok);
  assert.equal(snapshot.thread.turns[0].id, "native-turn");
  changeDuringRead = true;
  snapshot = await service.recovery("same");
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.code, "snapshot_stale");
  const p = await control(config, "pair", {});
  const base = `http://127.0.0.1:${config.ports.gateway}`;
  const paired = await fetch(base + "/phone-api/pair", {
    method: "POST",
    body: JSON.stringify({ deviceId: config.deviceId, code: p.code }),
  });
  const cookie = paired.headers.get("set-cookie").split(";")[0];
  const result = await fetch(base + "/codex-api/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      method: "turn/start",
      params: { threadId: "same", input: [] },
    }),
  });
  await result.arrayBuffer();
  assert.equal(writes, 1);
  const recovered = await (
    await fetch(base + "/phone-api/recovery?threadId=same", {
      headers: { cookie },
    })
  ).json();
  assert(recovered.ok);
  assert.equal(recovered.uncertainOperations[0].state, "uncertain");
  assert.equal(writes, 1);
  const acknowledged = await fetch(base + "/phone-api/recovery/ack", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ operationId: recovered.uncertainOperations[0].id }),
  });
  assert.equal(acknowledged.status, 200);
  assert.equal((await service.recovery("same")).uncertainOperations.length, 0);
  assert.equal(writes, 1);
  assert(
    !(await readFile(join(dir, "operations.json"), "utf8")).includes(
      "response lost after dispatch",
    ),
  );
});

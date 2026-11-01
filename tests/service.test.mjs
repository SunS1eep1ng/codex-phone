import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import net from "node:net";
import { serve, control } from "../src/service.mjs";
test("isolated lifecycle preserves identities, handles foreign saved port and refuses duplicate service", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codex-phone-service-"));
  const foreign = net.createServer();
  await new Promise((r) => foreign.listen(0, "127.0.0.1", r));
  const occupied = foreign.address().port;
  const config = {
    deviceId: "test-service",
    deviceName: "Mock",
    agentSecret: "test-agent",
    adminSecret: "test-admin",
    ports: { gateway: occupied, control: 0, desktop: 0 },
    relay: { provider: "provided", endpoint: "" },
  };
  const driver = new EventEmitter();
  Object.assign(driver, {
    state: "ready",
    port: 0,
    connect: async () => {},
    close: async () => {},
    health: async () => ({ ok: true, nativeThreadList: true }),
    rpc: async () => ({ data: [] }),
  });
  let starts = 0,
    stops = 0;
  const relay = {
    start: async () => starts++,
    stop: async () => stops++,
    health: async () => ({ ok: false, code: "relay_not_configured" }),
  };
  const service = await serve(config, dir, {
    driver,
    relay,
    ensureDesktop: async () => ({ ok: true, reused: true }),
    refreshInterval: 20,
  });
  t.after(async () => {
    await service.cleanup();
    await new Promise((r) => foreign.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  assert.notEqual(config.ports.gateway, occupied);
  assert.equal((await control(config, "status")).deviceId, "test-service");
  await assert.rejects(
    serve(config, dir, { driver, relay }),
    /lease is active/,
  );
  const saved = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  assert.equal(saved.agentSecret, "test-agent");
  assert.equal(saved.deviceId, "test-service");
  assert.equal(starts, 1);
  assert.equal((await control(config, "doctor")).ok, false);
  await service.cleanup();
  assert.equal(stops, 1);
  assert(foreign.listening);
  await service.cleanup();
  assert.equal(stops, 1);
});

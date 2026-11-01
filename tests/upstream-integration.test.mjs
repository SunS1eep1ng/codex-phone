import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import { PhoneAuth } from "../src/auth.mjs";
import { createGateway, createControl, listen } from "../src/gateway.mjs";
import { LocalAgent } from "../src/agent.mjs";
test("pinned upstream UI → authenticated gateway → Agent v1 → native mock, including large response, approvals and reconnect", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codex-phone-test-"));
  process.env.CODEX_HOME = dir;
  process.env.CODEXUI_DESKTOP_DRIVER = "agent";
  process.env.CODEXUI_AGENT_PAIRING_TOKEN = "isolated-agent-secret";
  process.env.CODEXUI_AGENT_DEVICE_ID = "test-pc";
  const { createServer } = await import("../dist/upstream/dist-cli/server.mjs");
  const upstream = createServer();
  const config = {
    deviceId: "test-pc",
    deviceName: "Mock PC",
    agentSecret: "isolated-agent-secret",
    adminSecret: "isolated-admin-secret",
    relay: { endpoint: "https://example.test" },
  };
  const auth = new PhoneAuth(config, {
    phones: [],
    sessions: [],
    pairing: null,
  });
  const control = createControl({
    config,
    upstream,
    actions: async () => ({ ok: true }),
  });
  const controlPort = await listen(control, 0);
  const driver = new EventEmitter();
  driver.health = async () => ({ ok: true });
  driver.rpc = async (method) =>
    method === "thread/list"
      ? { data: [{ id: "same-native-id" }], nextCursor: null }
      : method === "thread/read"
        ? {
            thread: {
              id: "same-native-id",
              turns: [
                {
                  id: "t1",
                  items: [
                    { type: "agentMessage", text: "x".repeat(2 * 1024 * 1024) },
                  ],
                },
              ],
            },
          }
        : { ok: true };
  const agent = new LocalAgent(config, driver);
  agent.start(controlPort);
  const g = createGateway({
    config,
    auth,
    upstream,
    health: driver.health,
    nativeRPC: driver.rpc,
  });
  const port = await listen(g.server, 0);
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    agent.stop();
    g.close();
    control.closeAllConnections();
    control.close();
    upstream.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const p = await auth.pairCode();
  const linked = await auth.pair({ deviceId: "test-pc", code: p.code });
  const cookie = "bridge_phone_session=" + linked.token;
  const headers = { cookie, "content-type": "application/json" };
  for (let i = 0; i < 50; i++) {
    const r = await fetch(base + "/codex-api/desktop-bridge/status", {
      headers,
    });
    if ((await r.json()).state === "ready") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const ui = await fetch(base + "/", { headers });
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /<html/);
  async function rpc(method) {
    const r = await fetch(base + "/codex-api/rpc", {
      method: "POST",
      headers,
      body: JSON.stringify({
        method,
        params: { threadId: "same-native-id", includeTurns: true },
      }),
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    return body.result;
  }
  // Wait for the real upstream hello acknowledgement, not just its HTTP server.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await rpc("thread/list")).data[0].id, "same-native-id");
  assert.equal(
    (await rpc("thread/read")).thread.turns[0].items[0].text.length,
    2 * 1024 * 1024,
  );
  const ws = new WebSocket(base.replace("http", "ws") + "/codex-api/ws", {
    headers: { cookie },
  });
  await once(ws, "open");
  const notification = once(ws, "message");
  driver.emit("event", {
    protocol: 1,
    kind: "notification",
    sequence: 1,
    payload: {
      method: "server/request",
      params: { id: 5, method: "item/commandExecution/requestApproval" },
    },
  });
  const data = JSON.parse((await notification)[0]);
  assert.equal(data.method, "server/request");
  ws.close();
  agent.ws.terminate();
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal((await rpc("thread/list")).data[0].id, "same-native-id");
});

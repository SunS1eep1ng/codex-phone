import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { once } from "node:events";
import { PhoneAuth } from "../src/auth.mjs";
import { createGateway, listen } from "../src/gateway.mjs";
async function setup(t, now = Date.now) {
  const config = {
    deviceId: "isolated-stream",
    deviceName: "Mock",
    relay: { endpoint: "https://example.test" },
  };
  const auth = new PhoneAuth(
    config,
    { phones: [], sessions: [], pairing: null },
    { now },
  );
  const p = await auth.pairCode();
  const linked = await auth.pair({ deviceId: config.deviceId, code: p.code });
  let response;
  const gateway = createGateway({
    config,
    auth,
    authCheckIntervalMs: 10,
    health: async () => ({ ok: true }),
    upstream: {
      attachWebSocket() {},
      app(req, res) {
        response = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: initial\n\n");
      },
    },
  });
  const port = await listen(gateway.server, 0);
  t.after(() => gateway.close());
  return {
    auth,
    linked,
    gateway,
    port,
    get response() {
      return response;
    },
    base: `http://127.0.0.1:${port}`,
    headers: { cookie: "bridge_phone_session=" + linked.token },
  };
}
test("revocation and session expiry terminate already-open event streams", async (t) => {
  for (const mode of ["revoke", "expire"])
    await t.test(mode, async (t) => {
      let now = 1;
      const env = await setup(t, () => now);
      const stream = await fetch(env.base + "/codex-api/events", {
        headers: env.headers,
      });
      const reader = stream.body.getReader();
      await reader.read();
      const closed = once(env.response, "close");
      if (mode === "revoke") await env.auth.revoke(env.linked.phoneId);
      else now += 29 * 86400000;
      await closed;
      assert(env.response.destroyed);
      env.response.write("data: must-not-deliver\n\n");
      try {
        const next = await reader.read();
        assert(next.done);
      } catch (e) {
        assert.match(e.message, /terminated|aborted|closed/i);
      }
      assert.equal(
        (await fetch(env.base + "/phone-api/health", { headers: env.headers }))
          .status,
        401,
      );
    });
});
test("a malformed Upgrade is rejected without terminating the gateway", async (t) => {
  const env = await setup(t);
  const socket = net.connect(env.port, "127.0.0.1");
  await once(socket, "connect");
  let response = "";
  socket.on("data", (b) => (response += b));
  const closed = once(socket, "close");
  socket.write(
    "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
  );
  await closed;
  assert.match(response, /^HTTP\/1.1 400/);
  assert.equal((await fetch(env.base + "/phone-api/info")).status, 200);
});
test("event-stream disconnections change only the affected document epoch", async (t) => {
  const config = {
    deviceId: "page-test",
    relay: { endpoint: "https://example.test" },
  };
  const auth = new PhoneAuth(config, {
    phones: [],
    sessions: [],
    pairing: null,
  });
  const p = await auth.pairCode(),
    linked = await auth.pair({ deviceId: config.deviceId, code: p.code });
  const wss = new WebSocketServer({ noServer: true });
  const gateway = createGateway({
    config,
    auth,
    health: async () => ({ ok: true }),
    recovery: async () => ({
      ok: true,
      epoch: "native-epoch",
      connection: { state: "ready", nativeReady: true },
    }),
    upstream: {
      app: (_q, r) => r.end("ok"),
      attachWebSocket: (server) =>
        server.on("upgrade", (req, socket, head) =>
          wss.handleUpgrade(req, socket, head, (ws) =>
            wss.emit("connection", ws),
          ),
        ),
    },
  });
  const port = await listen(gateway.server, 0);
  t.after(async () => {
    await gateway.close();
    wss.close();
  });
  const base = `http://127.0.0.1:${port}`,
    cookie = "bridge_phone_session=" + linked.token;
  const probe = async (pageId) =>
    (
      await (
        await fetch(base + "/phone-api/recovery?probe=1&pageId=" + pageId, {
          headers: { cookie },
        })
      ).json()
    ).epoch;
  const before = await probe("old-page");
  const newer = await probe("new-page");
  const socket = new WebSocket(base.replace("http", "ws") + "/codex-api/ws", {
    headers: { cookie: cookie + "; codex_phone_page=old-page" },
  });
  await once(socket, "open");
  socket.terminate();
  await once(socket, "close");
  let after;
  for (let i = 0; i < 20; i++) {
    after = await probe("old-page");
    if (after !== before) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.notEqual(after, before);
  assert.equal(await probe("new-page"), newer);
});

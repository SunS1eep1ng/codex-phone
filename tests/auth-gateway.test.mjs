import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { PhoneAuth } from "../src/auth.mjs";
import { createGateway, listen } from "../src/gateway.mjs";
const config = {
  deviceId: "test-pc",
  deviceName: "PC",
  relay: { endpoint: "https://example.test" },
};
function auth(now = Date.now) {
  return new PhoneAuth(
    config,
    { phones: [], sessions: [], pairing: null },
    { now },
  );
}
test("pairing expires, is one-use, has attempt limit and rejects wrong identity", async () => {
  let time = 0;
  const a = auth(() => time);
  let p = await a.pairCode();
  await assert.rejects(
    a.pair({ deviceId: "other", code: p.code }),
    /wrong_computer/,
  );
  time = 600001;
  await assert.rejects(
    a.pair({ deviceId: "test-pc", code: p.code }),
    /pairing_expired/,
  );
  p = await a.pairCode();
  for (let i = 0; i < 20; i++)
    await assert.rejects(
      a.pair({ deviceId: "test-pc", code: "wrong" }),
      /invalid_pairing_code/,
    );
  await assert.rejects(
    a.pair({ deviceId: "test-pc", code: p.code }),
    /pairing_locked/,
  );
  p = await a.pairCode();
  const linked = await a.pair({ deviceId: "test-pc", code: p.code });
  await assert.rejects(
    a.pair({ deviceId: "test-pc", code: p.code }),
    /pairing_expired/,
  );
  assert(!JSON.stringify(a.data).includes(linked.credential));
  await a.revoke(linked.phoneId);
  await assert.rejects(a.session(linked), /phone_not_authorized/);
});
function wsOpen(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_r, res) => {
      res.resume();
      reject(Error(String(res.statusCode)));
    });
    ws.once("error", reject);
  });
}
test("Host rewriting cannot bypass HTTP or WS; revocation closes existing WS", async (t) => {
  const a = auth();
  const wss = new WebSocketServer({ noServer: true });
  const upstream = {
    app: (_req, res) => res.end("native-ui"),
    attachWebSocket: (s) =>
      s.on("upgrade", (r, socket, h) =>
        wss.handleUpgrade(r, socket, h, (ws) => wss.emit("connection", ws)),
      ),
  };
  const g = createGateway({
    config,
    auth: a,
    upstream,
    health: async () => ({ ok: true }),
  });
  const port = await listen(g.server, 0);
  t.after(() => {
    g.close();
    wss.close();
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal(
    (await fetch(base + "/", { headers: { Host: "localhost" } })).status,
    401,
  );
  assert.equal((await fetch(base + "/codex-api/agent/ws")).status, 401);
  await assert.rejects(
    wsOpen(base.replace("http", "ws") + "/codex-api/ws", { Host: "localhost" }),
    /401/,
  );
  const p = await a.pairCode();
  const response = await fetch(base + "/phone-api/pair", {
    method: "POST",
    body: JSON.stringify({ deviceId: "test-pc", code: p.code }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(base + "/", { headers: { cookie } })).status, 200);
  assert.equal(
    (
      await fetch(base + "/codex-api/free-mode", {
        method: "POST",
        headers: { cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/codex-api/rpc", {
        method: "POST",
        headers: { cookie, Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  const ws = await wsOpen(base.replace("http", "ws") + "/codex-api/ws", {
    cookie,
  });
  const closed = new Promise((r) => ws.once("close", r));
  await a.revoke(data.phoneId);
  await closed;
  assert.equal(
    (await fetch(base + "/", { headers: { cookie, Host: "localhost" } }))
      .status,
    401,
  );
  await assert.rejects(
    wsOpen(base.replace("http", "ws") + "/codex-api/ws", { cookie }),
    /401/,
  );
});

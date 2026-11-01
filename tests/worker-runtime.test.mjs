import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
test("real Workers runtime preserves authenticated WSS upgrades and KV registration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codex-phone-worker-"));
  let source = await readFile(
    new URL("../src/worker-template.mjs", import.meta.url),
    "utf8",
  );
  source = source.slice(0, source.lastIndexOf("export default"));
  const script =
    source +
    `export default{fetch(request,env){return handleRequest(request,env,async request=>{if(request.headers.get('cookie')!=='bridge_phone_session=synthetic')return new Response('unauthorized',{status:401});if(request.headers.get('upgrade')==='websocket'){const pair=new WebSocketPair();pair[1].accept();pair[1].addEventListener('message',e=>pair[1].send(e.data));return new Response(null,{status:101,webSocket:pair[0]});}return new Response('native-test');});}}`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-10-30",
      bindings: { DEVICE_ID: "test-pc", REGISTRATION_SECRET: "test-secret" },
      kvNamespaces: ["DESKTOP_ENDPOINTS"],
    }),
  );
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const registration = await mf.dispatchFetch(
    "https://worker.test/_bridge/register",
    {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
      body: JSON.stringify({
        deviceId: "test-pc",
        origin: "https://synthetic.trycloudflare.com",
      }),
    },
  );
  assert.equal(registration.status, 200);
  assert.equal(
    (
      await mf.dispatchFetch("https://worker.test/codex-api/ws", {
        headers: { Upgrade: "websocket" },
      })
    ).status,
    401,
  );
  const response = await mf.dispatchFetch("https://worker.test/codex-api/ws", {
    headers: { Upgrade: "websocket", Cookie: "bridge_phone_session=synthetic" },
  });
  assert.equal(response.status, 101);
  const ws = response.webSocket;
  assert(ws);
  ws.accept();
  const message = new Promise((r) =>
    ws.addEventListener("message", (e) => r(e.data), { once: true }),
  );
  ws.send("approval-event");
  assert.equal(await message, "approval-event");
  ws.close(1000);
});

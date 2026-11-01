import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createControl, listen } from "../src/gateway.mjs";
import { control } from "../src/service.mjs";
import { controlRequestHeaders } from "../src/control-auth.mjs";
const configuration = () => ({
  deviceId: "isolated-control",
  adminSecret: "synthetic-control-key",
  agentSecret: "synthetic-agent-key",
  ports: { control: 0 },
});
test("control authenticates both endpoints without disclosing its key to a foreign port", async (t) => {
  const config = configuration();
  let received;
  const foreign = http.createServer((req, res) => {
    received = req.headers;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, deviceId: "foreign" }));
  });
  config.ports.control = await listen(foreign, 0);
  t.after(() => {
    foreign.closeAllConnections();
    foreign.close();
  });
  await assert.rejects(control(config, "status"), {
    code: "control_identity_mismatch",
  });
  assert.equal(received.authorization, undefined);
  assert(!JSON.stringify(received).includes(config.adminSecret));
});
test("control request signatures bind body and reject replay; wrong response key is rejected", async (t) => {
  const config = configuration();
  let calls = 0;
  const server = createControl({
    config,
    upstream: { attachWebSocket() {} },
    actions: async (name, body) => {
      calls++;
      return { ok: true, name, body };
    },
  });
  config.ports.control = await listen(server, 0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const value = await control(config, "revoke", { phoneId: "synthetic" });
  assert.equal(value.deviceId, config.deviceId);
  assert.equal(value.service, "codex-phone");
  assert.equal(calls, 1);
  const text = JSON.stringify({ phoneId: "one" }),
    headers = controlRequestHeaders(config, "POST", "/revoke", text);
  const base = `http://127.0.0.1:${config.ports.control}`;
  assert.equal(
    (
      await fetch(base + "/revoke", {
        method: "POST",
        headers,
        body: JSON.stringify({ phoneId: "changed" }),
      })
    ).status,
    401,
  );
  assert.equal(calls, 1);
  assert.equal(
    (await fetch(base + "/revoke", { method: "POST", headers, body: text }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(base + "/revoke", { method: "POST", headers, body: text }))
      .status,
    401,
  );
  assert.equal(calls, 2);
  await assert.rejects(
    control({ ...config, adminSecret: "different-key" }, "status"),
    { code: "control_identity_mismatch" },
  );
});

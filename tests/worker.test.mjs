import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/worker-template.mjs";
test("registration is authenticated, constrained and forwards cookies/upgrade without admin headers", async () => {
  let entry;
  const env = {
    DEVICE_ID: "test-pc",
    REGISTRATION_SECRET: "test-secret",
    DESKTOP_ENDPOINTS: {
      put: async (_k, v) => (entry = JSON.parse(v)),
      get: async () => entry,
    },
  };
  let result = await handleRequest(
    new Request("https://worker.test/_bridge/register", {
      method: "POST",
      body: "{}",
    }),
    env,
  );
  assert.equal(result.status, 401);
  const register = (origin) =>
    handleRequest(
      new Request("https://worker.test/_bridge/register", {
        method: "POST",
        headers: { authorization: "Bearer test-secret" },
        body: JSON.stringify({ deviceId: "test-pc", origin }),
      }),
      env,
    );
  assert.equal((await register("https://internal.example")).status, 400);
  assert.equal(
    (await register("https://test-origin.trycloudflare.com")).status,
    200,
  );
  result = await handleRequest(
    new Request("https://worker.test/codex-api/rpc", {
      method: "POST",
      headers: { Cookie: "phone=test", "x-codex-admin-key": "secret" },
      body: "{}",
    }),
    env,
    async (req) => {
      assert.equal(req.headers.get("cookie"), "phone=test");
      assert.equal(req.headers.get("x-codex-admin-key"), null);
      assert.equal(new URL(req.url).hostname, "test-origin.trycloudflare.com");
      return new Response("Unauthorized", { status: 401 });
    },
  );
  assert.equal(result.status, 401);
  assert.equal(
    (
      await handleRequest(
        new Request("https://worker.test/_phone-local/status"),
        env,
      )
    ).status,
    403,
  );
});

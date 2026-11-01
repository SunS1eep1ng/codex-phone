import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LocalAgent, encodeResponse } from "../src/agent.mjs";
test("large native responses chunk and reassemble without truncation", () => {
  const value = {
    version: 1,
    type: "response",
    id: "r1",
    ok: true,
    result: { history: "x".repeat(2 * 1024 * 1024) },
  };
  const frames = encodeResponse(value).map(JSON.parse);
  assert(frames.length > 1);
  assert(frames.every((f) => f.data.length < 1024 * 1024));
  assert.deepEqual(
    JSON.parse(Buffer.concat(frames.map((f) => Buffer.from(f.data, "base64")))),
    value,
  );
});
test("concurrent duplicate requests execute once; changed payload rejected", async () => {
  const driver = new EventEmitter();
  let calls = 0;
  driver.rpc = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true };
  };
  const a = new LocalAgent({}, driver);
  const sent = [];
  let closed = false;
  const ws = {
    readyState: 1,
    send: (f) => sent.push(JSON.parse(f)),
    close: () => (closed = true),
  };
  const m = {
    id: "r1",
    method: "rpc",
    params: { method: "turn/start", params: { threadId: "test" } },
  };
  await Promise.all([a.respond(m, ws), a.respond(m, ws)]);
  assert.equal(calls, 1);
  assert.equal(sent.length, 2);
  await a.respond({ ...m, params: { method: "different" } }, ws);
  assert(closed);
  a.stop();
});

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LocalAgent, encodeResponse } from "../src/agent.mjs";
class MockSocket extends EventEmitter {
  constructor({ autoCallback = true } = {}) {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.frames = [];
    this.callbacks = [];
    this.autoCallback = autoCallback;
    this.closeCode = null;
  }
  send(frame, callback) {
    this.frames.push(JSON.parse(frame));
    if (this.autoCallback) callback?.();
    else this.callbacks.push(callback);
  }
  close(code) {
    this.closeCode = code;
    this.terminate();
  }
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error("Mock transport did not settle");
};
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
    send: (f, callback) => {
      sent.push(JSON.parse(f));
      callback?.();
    },
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
test("production response chunks wait for each send callback and preserve request identity", async () => {
  const driver = new EventEmitter();
  let executions = 0,
    requestId;
  driver.rpc = async (_method, _params, context) => {
    executions++;
    requestId = context.requestId;
    return { history: "x".repeat(2 * 1024 * 1024) };
  };
  const agent = new LocalAgent({}, driver);
  const ws = new MockSocket({ autoCallback: false });
  const response = agent.respond(
    {
      id: "history-r1",
      method: "rpc",
      params: { method: "thread/read", params: { threadId: "same" } },
    },
    ws,
  );
  await waitFor(() => ws.frames.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ws.frames.length, 1);
  let complete = false;
  response.then(() => (complete = true));
  for (let i = 0; i < 20 && !complete; i++) {
    ws.callbacks.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await response;
  assert.equal(executions, 1);
  assert.equal(requestId, "history-r1");
  assert(ws.frames.length > 1);
  const body = JSON.parse(
    Buffer.concat(ws.frames.map((frame) => Buffer.from(frame.data, "base64"))),
  );
  assert.equal(body.result.history.length, 2 * 1024 * 1024);
  assert.equal(agent.queues.get(ws).bytes, 0);
  agent.stop();
});
test("total queue byte limit disconnects a slow consumer and requires a state resync", async () => {
  const driver = new EventEmitter();
  const agent = new LocalAgent({}, driver, {
    maxQueueBytes: 1024,
    sendTimeoutMs: 1000,
  });
  const ws = new MockSocket({ autoCallback: false });
  agent.ws = ws;
  agent.connected = true;
  agent.needsResync = false;
  const required = [];
  agent.on("resync-needed", (event) => required.push(event));
  const first = agent.send({ data: "x".repeat(600) }, ws);
  const rejected = assert.rejects(first, { code: "agent_backpressure" });
  await assert.rejects(agent.send({ data: "x".repeat(600) }, ws), {
    code: "agent_backpressure",
  });
  await rejected;
  assert.equal(ws.closeCode, 1013);
  assert.equal(agent.connected, false);
  assert.equal(agent.queues.size, 0);
  assert.equal(ws.frames.length, 1);
  assert.equal(required.length, 1);
  agent.stop();
});
test("same-id in-flight write survives transport loss without a second native execution", async () => {
  const driver = new EventEmitter();
  let resolve,
    calls = 0;
  const gate = new Promise((r) => (resolve = r));
  driver.rpc = async () => {
    calls++;
    await gate;
    return { turn: { id: "same-native-turn" } };
  };
  const agent = new LocalAgent({}, driver),
    old = new MockSocket(),
    current = new MockSocket();
  const message = {
    id: "write-r1",
    method: "rpc",
    params: { method: "turn/start", params: { threadId: "same" } },
  };
  const first = agent.respond(message, old);
  old.terminate();
  const second = agent.respond(message, current);
  resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(old.frames.length, 0);
  assert.equal(current.frames[0].result.turn.id, "same-native-turn");
  agent.stop();
});
test("unknown native write outcome is cached for same-id retry, never replayed", async () => {
  const driver = new EventEmitter();
  let calls = 0;
  driver.rpc = async () => {
    calls++;
    throw Object.assign(Error("Refresh native state before retrying"), {
      code: "native_outcome_unknown",
      outcomeUnknown: true,
    });
  };
  const agent = new LocalAgent({}, driver),
    first = new MockSocket(),
    second = new MockSocket();
  const message = {
    id: "uncertain-r1",
    method: "rpc",
    params: { method: "turn/start", params: { threadId: "same" } },
  };
  await agent.respond(message, first);
  await agent.respond(message, second);
  assert.equal(calls, 1);
  assert.equal(second.frames[0].error.code, "native_outcome_unknown");
  assert.equal(second.frames[0].error.outcomeUnknown, true);
  agent.stop();
});
test("an evicted result remains a processed tombstone and cannot re-execute a write", async () => {
  const driver = new EventEmitter();
  let calls = 0;
  driver.rpc = async () => {
    calls++;
    return { turn: { id: "same-native-turn" } };
  };
  const agent = new LocalAgent({}, driver, { maxCachedBytes: 1 });
  const message = {
    id: "large-r1",
    method: "rpc",
    params: { method: "turn/start", params: { threadId: "same" } },
  };
  await agent.respond(message, new MockSocket());
  const retry = new MockSocket();
  await agent.respond(message, retry);
  assert.equal(calls, 1);
  assert.equal(retry.frames[0].error.code, "already_processed");
  agent.stop();
});
test("hello acknowledgement gates connected status and each reconnect/native ready requests resync", async () => {
  const driver = new EventEmitter();
  driver.epoch = "native:1";
  const sockets = [];
  const agent = new LocalAgent(
    {
      deviceId: "synthetic",
      agentSecret: "synthetic",
      projectVersion: "0.1.1",
    },
    driver,
    {
      createSocket: () => {
        const ws = new MockSocket();
        ws.readyState = 0;
        sockets.push(ws);
        return ws;
      },
      reconnectDelayMs: 2,
    },
  );
  const resync = [];
  agent.on("resync", (event) => resync.push(event));
  agent.start(1);
  const open = (ws) => {
    ws.readyState = 1;
    ws.emit("open");
  };
  const accept = (ws) =>
    ws.emit(
      "message",
      JSON.stringify({ version: 1, type: "hello/ack", accepted: true }),
    );
  open(sockets[0]);
  assert.equal(agent.connected, false);
  assert.equal(sockets[0].frames[0].type, "hello");
  assert.equal(sockets[0].frames[0].agentVersion, "codex-phone/0.1.1");
  accept(sockets[0]);
  assert.equal(agent.connected, true);
  assert.equal(resync[0].reason, "agent-connected");
  const firstEpoch = agent.epoch;
  sockets[0].terminate();
  assert.equal(agent.connected, false);
  await waitFor(() => sockets.length === 2);
  open(sockets[1]);
  accept(sockets[1]);
  assert.notEqual(agent.epoch, firstEpoch);
  assert.equal(
    resync.filter((event) => event.reason === "agent-connected").length,
    2,
  );
  driver.epoch = "native:2";
  driver.emit("ready", { epoch: driver.epoch });
  assert.equal(resync.at(-1).reason, "native-ready");
  assert.equal(resync.at(-1).epoch, "native:2");
  sockets[0].emit("close");
  assert.equal(agent.connected, true);
  agent.stop();
  assert.equal(agent.connected, false);
  assert.equal(driver.listenerCount("event"), 0);
});

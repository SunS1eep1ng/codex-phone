import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CDP, NativeDriver } from "../src/native.mjs";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
class MockCDP extends EventEmitter {
  constructor({ bootstrap } = {}) {
    super();
    this.bootstrap = bootstrap;
    this.closed = 0;
    this.bootstrapSource = "";
  }
  async call(method) {
    return method === "Runtime.queryObjects"
      ? { objects: { objectId: "synthetic-instances" } }
      : {};
  }
  async evaluate(expression, byValue = true) {
    if (!byValue) return { objectId: "synthetic-prototype" };
    if (expression.includes("const protocol = 1;")) {
      this.bootstrapSource = expression;
      if (this.bootstrap) await this.bootstrap.promise;
      return { protocol: 1, hostId: "local" };
    }
    return true;
  }
  close() {
    this.closed++;
    this.emit("disconnect");
  }
}
function mockDriver(clients, options = {}) {
  let index = 0;
  const port = 12345;
  return new NativeDriver({
    port,
    verify: async () => {},
    fetchTargets: async () => [
      {
        type: "page",
        url: "app://-/index.html",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/synthetic-cdp`,
      },
    ],
    connectClient: async () => clients[index++],
    closeTimeoutMs: 10,
    ...options,
  });
}
test("ordinary native errors preserve the transport and concurrent native write", async () => {
  const read = deferred(),
    write = deferred();
  let calls = 0,
    closed = 0;
  const client = {
    evaluate: () => (++calls === 1 ? read.promise : write.promise),
    close: () => closed++,
  };
  const driver = new NativeDriver({ port: 1 });
  driver.client = client;
  driver.state = "ready";
  const first = driver.rpc("thread/read", { threadId: "missing" });
  const second = driver.rpc("turn/start", { threadId: "existing" });
  const outcomes = Promise.allSettled([first, second]);
  await tick();
  read.reject(
    Object.assign(Error("thread not found"), { code: "native_rpc_error" }),
  );
  await tick();
  write.resolve({ turn: { id: "same-native-turn" } });
  const result = await outcomes;
  assert.equal(result[0].status, "rejected");
  assert.equal(result[1].status, "fulfilled");
  assert.equal(closed, 0);
  assert.equal(driver.client, client);
  assert.equal(driver.state, "ready");
});
test("an old failed request never closes a newer connection or replays a write", async () => {
  const pending = deferred();
  let oldClosed = 0,
    newClosed = 0,
    calls = 0;
  const old = {
    evaluate: () => {
      calls++;
      return pending.promise;
    },
    close: () => oldClosed++,
  };
  const current = { close: () => newClosed++ };
  const driver = new NativeDriver({ port: 1 });
  driver.client = old;
  driver.state = "ready";
  const request = driver.rpc("turn/start", { threadId: "same" });
  await tick();
  driver.client = current;
  driver.epoch = "new-connection";
  pending.reject(
    Object.assign(Error("CDP_TIMEOUT: Runtime.evaluate"), {
      code: "cdp_timeout",
    }),
  );
  await assert.rejects(
    request,
    (error) =>
      error.code === "native_outcome_unknown" && error.outcomeUnknown === true,
  );
  assert.equal(calls, 1);
  assert.equal(oldClosed, 1);
  assert.equal(newClosed, 0);
  assert.equal(driver.client, current);
  assert.equal(driver.state, "ready");
});
test("close cancels an old handshake; later connect uses a new renderer namespace", async () => {
  const gate = deferred(),
    first = new MockCDP({ bootstrap: gate }),
    second = new MockCDP();
  const driver = mockDriver([first, second]);
  let ready = 0;
  driver.on("ready", () => ready++);
  const connecting = driver.connect();
  const rejection = assert.rejects(connecting, {
    code: "native_connection_cancelled",
  });
  while (!first.bootstrapSource) await tick();
  const firstEpoch = driver.epoch;
  await driver.close();
  gate.resolve();
  await rejection;
  assert.equal(driver.client, null);
  assert.equal(driver.state, "disconnected");
  assert.equal(ready, 0);
  await driver.connect();
  assert.equal(driver.client, second);
  assert.equal(ready, 1);
  assert.notEqual(driver.epoch, firstEpoch);
  assert.notEqual(first.bootstrapSource, second.bootstrapSource);
  await driver.close();
});
test("close during verification cannot create a late CDP connection", async () => {
  const gate = deferred();
  let opened = 0;
  const driver = mockDriver([], {
    verify: () => gate.promise,
    connectClient: async () => {
      opened++;
      return new MockCDP();
    },
  });
  const connecting = driver.connect();
  const rejection = assert.rejects(connecting, {
    code: "native_connection_cancelled",
  });
  await driver.close();
  gate.resolve();
  await rejection;
  assert.equal(opened, 0);
  assert.equal(driver.client, null);
});
test("close is bounded even if renderer disposal never replies", async () => {
  let closed = 0;
  const driver = new NativeDriver({ port: 1, closeTimeoutMs: 10 });
  driver.client = {
    evaluate: () => new Promise(() => {}),
    close: () => closed++,
  };
  const start = Date.now();
  await driver.close();
  assert(Date.now() - start < 500);
  assert(closed > 0);
  assert.equal(driver.state, "disconnected");
});
test("CDP close rejects pending calls immediately and prevents new sends", async () => {
  const ws = new EventEmitter();
  ws.readyState = 1;
  let sends = 0;
  ws.send = (_data, callback) => {
    sends++;
    callback?.();
  };
  ws.terminate = () => {
    ws.readyState = 3;
    ws.emit("close");
  };
  const cdp = new CDP(ws);
  const pending = cdp.call("Runtime.evaluate", {}, 5000);
  const rejection = assert.rejects(pending, { code: "cdp_disconnected" });
  cdp.close();
  await rejection;
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.call("Runtime.evaluate"), {
    code: "cdp_disconnected",
  });
  assert.equal(sends, 1);
});
test("a transport that closes at the end of handshake cannot publish native ready", async () => {
  const client = new MockCDP();
  const original = client.call.bind(client);
  client.call = async (method) => {
    const result = await original(method);
    if (method === "Runtime.releaseObjectGroup") client.closed = true;
    return result;
  };
  const driver = mockDriver([client]);
  let ready = 0;
  driver.on("ready", () => ready++);
  await assert.rejects(driver.connect(), { code: "desktop_unavailable" });
  assert.equal(ready, 0);
  assert.equal(driver.client, null);
  assert.equal(driver.state, "error");
});

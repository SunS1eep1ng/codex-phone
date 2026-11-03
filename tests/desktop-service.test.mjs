import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import {
  installServiceManager,
  discoverServiceModules,
} from "../src/desktop-service.mjs";
import {
  createRendererBootstrapSource,
  createRendererCommandSource,
} from "../src/renderer-bootstrap.ts";

const url = "app://-/assets/app-shared-synthetic.js";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ initial = true } = {}) {
  const subscriptions = [],
    calls = [],
    released = [];
  const lease = (label) => {
    const result = Promise.resolve({
      [Symbol.dispose]() {
        released.push(label);
      },
    });
    result.onRpcBroken = () => {};
    result[Symbol.dispose] = () => {};
    return result;
  };
  const entries = [
    {
      summary: { conversationId: "native-thread" },
      requests: [
        {
          id: 42,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "native-thread", command: "synthetic-command" },
        },
      ],
    },
  ];
  let hostListener;
  const remote = {
    dup() {
      return this;
    },
    onRpcBroken() {},
    [Symbol.dispose]() {
      released.push("manager");
    },
    subscribe(request) {
      subscriptions.push(request);
      if (request.type === "host" && initial)
        queueMicrotask(() => request.listener(entries));
      return lease(request.event || request.type);
    },
    async getConversation() {
      return entries[0];
    },
    async sendRequest(method, params) {
      calls.push({ method, params });
      return method === "thread/list"
        ? { data: [{ id: "native-thread" }] }
        : { thread: { id: "native-thread", turns: [] } };
    },
    async replyWithCommandExecutionApprovalDecision(...args) {
      calls.push({ reply: args });
    },
  };
  const service = {
    dup() {
      return this;
    },
    subscribe(host, listener) {
      assert.equal(host, "local");
      hostListener = listener;
      queueMicrotask(() => listener({ status: "ready", manager: remote }));
      return lease("registry");
    },
    [Symbol.dispose]() {
      released.push("service");
    },
  };
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    Symbol,
    loadModule: async (path) => {
      assert.equal(path, url);
      return { syntheticExport: { appServerManagers: service } };
    },
  });
  const start = (extra = {}) =>
    vm.runInContext(
      `(${installServiceManager.toString()})(${JSON.stringify({ moduleUrls: [url], managerKey: "synthetic_manager", timeoutMs: 50, ...extra })}, loadModule)`,
      context,
    );
  return {
    context,
    start,
    remote,
    entries,
    subscriptions,
    calls,
    released,
    host: (value) => hostListener(value),
  };
}

test("new Desktop manager service continues native RPC without constructing a renderer manager", async () => {
  const f = fixture();
  const ready = await f.start();
  assert.equal(ready.kind, "desktop-service-rpc");
  const manager = f.context.synthetic_manager;
  assert.equal(manager.getHostId(), "local");
  assert.equal(manager.getRecentConversations()[0].id, "native-thread");
  await manager.sendRequest("thread/list", { limit: 1 });
  assert.equal(f.calls[0].method, "thread/list");
  manager.dispose();
  assert.equal(manager.disposed, true);
  assert(f.released.includes("registry"));
  assert(f.released.includes("recentThreads") || f.released.includes("host"));
  assert(f.released.includes("manager"));
  assert(f.released.includes("service"));
});

test("pending service approvals seed the existing adapter and respond through the native RPC capability", async () => {
  const f = fixture();
  await f.start();
  const events = [];
  f.context.synthetic_event = (value) => events.push(JSON.parse(value));
  await vm.runInContext(
    createRendererBootstrapSource("synthetic_event", "synthetic"),
    f.context,
  );
  const pending = await vm.runInContext(
    createRendererCommandSource(
      "rpc",
      { method: "codex-web/local/server-requests/pending" },
      "synthetic",
    ),
    f.context,
  );
  assert.equal(pending.length, 1);
  assert.equal(pending[0].params.command, "synthetic-command");
  await vm.runInContext(
    createRendererCommandSource(
      "rpc",
      {
        method: "codex-web/local/server-requests/respond",
        params: { id: 42, result: { decision: "accept" } },
      },
      "synthetic",
    ),
    f.context,
  );
  assert.deepEqual(f.calls[0].reply, ["native-thread", 42, "accept"]);
  assert(
    events.some((event) => event.payload?.method === "server/request/resolved"),
  );
  f.context.synthetic.dispose();
  assert.equal(f.context.synthetic_manager.disposed, true);
});

test("service notifications and completion events are forwarded and old callbacks stop after replacement", async () => {
  const f = fixture();
  await f.start();
  const manager = f.context.synthetic_manager,
    events = [];
  manager.addNotificationCallback(["turn/completed"], (event) =>
    events.push(event),
  );
  manager.addTurnCompletedListener((event) => events.push(event));
  const stream = f.subscriptions.find((s) => s.type === "notification");
  stream.listener({
    method: "turn/completed",
    params: { threadId: "native-thread" },
  });
  f.subscriptions
    .find((s) => s.event === "turn-completed")
    .listener({ conversationId: "native-thread" });
  assert.equal(events.length, 2);
  f.host({ status: "disconnected" });
  await assert.rejects(
    manager.sendRequest("thread/list", {}),
    /Compatible native Desktop manager required/,
  );
  stream.listener({ method: "turn/completed" });
  assert.equal(events.length, 2);
  await tick();
});

test("a missing initial snapshot or cancelled generation releases service capabilities without publishing", async () => {
  const absent = fixture({ initial: false });
  await assert.rejects(absent.start(), /snapshot timed out/);
  assert.equal(absent.context.synthetic_manager, undefined);
  assert(absent.released.includes("manager"));
  const cancelled = fixture();
  cancelled.context.synthetic_cancelled = true;
  await assert.rejects(
    cancelled.start({ generation: 1, familyNamespace: "synthetic" }),
    /lifecycle was cancelled/,
  );
  assert.equal(cancelled.context.synthetic_manager, undefined);
  assert(cancelled.released.includes("service"));
});

test("service discovery only imports loaded local application modules and removes its debugger listener", async () => {
  const client = new EventEmitter();
  const calls = [];
  client.call = async (method) => {
    calls.push(method);
    if (method === "Debugger.enable")
      for (const candidate of [
        url,
        "https://synthetic.invalid/app-shared-foreign.js",
        "app://-/assets/other.js",
      ])
        client.emit("event", {
          method: "Debugger.scriptParsed",
          params: { url: candidate },
        });
  };
  assert.deepEqual(await discoverServiceModules(client), [url]);
  assert.deepEqual(calls, ["Debugger.enable", "Debugger.disable"]);
  assert.equal(client.listenerCount("event"), 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { NativeDriver } from "../src/native.mjs";
import {
  CODEX_DESKTOP_ADAPTER_GLOBAL as name,
  createRendererBootstrapSource,
  createRendererCommandSource,
  createRendererDisposeSource,
} from "../src/renderer-bootstrap.ts";
test("native adapter resumes the same thread, reads canonical history and forwards approval replies", async () => {
  const calls = [],
    events = [],
    listeners = {};
  const manager = {
    getHostId: () => "local",
    getConversation: () => ({
      requests: [
        {
          id: 7,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "same" },
        },
      ],
    }),
    addApprovalRequestListener: (fn) => {
      listeners.approve = fn;
      return () => {};
    },
    addNotificationCallback: () => () => {},
    addTurnCompletedListener: () => () => {},
    addStreamRoleStateCallback: () => () => {},
    getCompleteConversationTurns: async () => [{ id: "canonical" }],
    sendRequest: async (method, params) => {
      calls.push({ method, params });
      return method === "thread/read"
        ? { thread: { id: "same", turns: [] } }
        : { turn: { id: "native-turn" } };
    },
  };
  const context = vm.createContext({
    [name + "_manager"]: manager,
    binding: (event) => events.push(JSON.parse(event)),
    electronBridge: { sendMessageFromView: async (value) => calls.push(value) },
  });
  const hello = await vm.runInContext(
    createRendererBootstrapSource("binding"),
    context,
  );
  assert.equal(hello.hostId, "local");
  await vm.runInContext(
    createRendererCommandSource("startTurn", { threadId: "same", input: [] }),
    context,
  );
  assert.equal(calls[0].method, "thread/resume");
  assert.equal(calls[1].method, "turn/start");
  assert.equal(calls[1].params.threadId, "same");
  const history = await vm.runInContext(
    createRendererCommandSource("rpc", {
      method: "thread/read",
      params: { threadId: "same", includeTurns: true },
    }),
    context,
  );
  assert.equal(history.thread.turns[0].id, "canonical");
  listeners.approve({
    conversationId: "same",
    requestId: 7,
    kind: "commandExecution",
  });
  assert.equal(events.at(-1).payload.method, "server/request");
  await vm.runInContext(
    createRendererCommandSource("rpc", {
      method: "codex-web/local/server-requests/respond",
      params: { id: 7, result: { decision: "accept" } },
    }),
    context,
  );
  assert.equal(
    calls.at(-1).type,
    "reply-with-command-execution-approval-decision",
  );
  assert.equal(calls.at(-1).conversationId, "same");
  await vm.runInContext(createRendererDisposeSource(), context);
  assert.equal(context[name], undefined);
});
test("lost renderer adapter resets the native connection without replaying a turn", async () => {
  const driver = new NativeDriver({ port: 1 });
  let calls = 0,
    closed = 0;
  driver.client = {
    evaluate: async () => {
      calls++;
      throw Error("Execution context destroyed");
    },
    close: () => closed++,
  };
  await assert.rejects(
    driver.rpc("turn/start", { threadId: "same" }),
    /Execution context destroyed/,
  );
  assert.equal(calls, 1);
  assert.equal(closed, 1);
  assert.equal(driver.client, null);
  assert.equal(driver.state, "error");
});

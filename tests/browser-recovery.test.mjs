import test from "node:test";
import assert from "node:assert/strict";
import {
  parseThreadId,
  createPageIdentity,
  acknowledgeUncertainOperations,
  hasUnsentDraft,
  createRecoveryController,
} from "../src/browser-recovery.mjs";

test("each document gets a non-authentication correlation cookie, Secure only on HTTPS", () => {
  let counter = 0;
  const document = { cookie: "" };
  const window = {
    crypto: { randomUUID: () => `page-${++counter}` },
    location: { protocol: "https:" },
  };
  const first = createPageIdentity(window, document);
  assert.equal(first, "page-1");
  assert.equal(
    document.cookie,
    "codex_phone_page=page-1; Path=/; SameSite=Strict; Secure",
  );
  window.location.protocol = "http:";
  const next = createPageIdentity(window, document);
  assert.notEqual(next, first);
  assert.equal(
    document.cookie,
    "codex_phone_page=page-2; Path=/; SameSite=Strict",
  );
});
test("page identification works on WebViews without randomUUID using getRandomValues", () => {
  const window = {
    crypto: {
      getRandomValues: (bytes) => {
        for (let i = 0; i < bytes.length; i++) bytes[i] = i;
        return bytes;
      },
    },
    location: { protocol: "https:" },
  };
  const document = { cookie: "" };
  assert.equal(
    createPageIdentity(window, document),
    "000102030405060708090a0b0c0d0e0f",
  );
});
test("explicit review acknowledgement filters pending/completed records and never sends a native RPC", async () => {
  const sent = [];
  const count = await acknowledgeUncertainOperations(
    [
      { id: "unknown-1", state: "uncertain" },
      { id: "pending-1", state: "pending" },
      { id: "done-1", state: "acknowledged" },
      { id: "unknown-1", state: "uncertain" },
      { id: "unknown-2", state: "uncertain" },
    ],
    async (body) => sent.push(body),
  );
  assert.equal(count, 2);
  assert.deepEqual(sent, [
    { operationId: "unknown-1" },
    { operationId: "unknown-2" },
  ]);
  let calls = 0;
  await assert.rejects(
    acknowledgeUncertainOperations(
      [
        { id: "one", state: "uncertain" },
        { id: "two", state: "uncertain" },
      ],
      async () => {
        calls++;
        throw Error("network");
      },
    ),
    /network/,
  );
  assert.equal(calls, 1);
});

const ready = (epoch = "epoch-1", extra = {}) => ({
  ok: true,
  epoch,
  connection: { state: "ready", nativeReady: true },
  pendingApprovals: [],
  uncertainOperations: [],
  ...extra,
});
function harness() {
  const result = {
    packet: ready(),
    thread: "native-thread",
    draft: false,
    notices: [],
    reloads: [],
  };
  result.controller = createRecoveryController({
    fetchSnapshot: async () => {
      if (result.packet instanceof Error) throw result.packet;
      return result.packet;
    },
    getThreadId: () => result.thread,
    hasDraft: () => result.draft,
    reload: (snapshot) => result.reloads.push(snapshot),
    notify: (notice) => result.notices.push(notice),
  });
  return result;
}

test("recovery parses the two pinned native thread routes without accepting path injection", () => {
  assert.equal(
    parseThreadId("#/device/desktop/thread/019-native?view=chat"),
    "019-native",
  );
  assert.equal(parseThreadId("#/thread/019-native"), "019-native");
  for (const hash of [
    "#/device/desktop",
    "#/thread/%2Fsecret",
    "#/thread/%E0%A4%A",
    "#/thread/id/extra",
    "#/thread/<script>",
  ])
    assert.equal(parseThreadId(hash), "");
});
test("draft protection includes whitespace, editable text and selected attachments", () => {
  let textarea = [{ value: "  " }],
    editables = [],
    inputs = [];
  const document = {
    querySelectorAll: (selector) =>
      selector === "textarea"
        ? textarea
        : selector.startsWith("[contenteditable]")
          ? editables
          : inputs,
  };
  assert.equal(hasUnsentDraft(document), true);
  textarea = [];
  editables = [{ textContent: "unsent text" }];
  assert.equal(hasUnsentDraft(document), true);
  editables = [];
  inputs = [{ files: [{ name: "unsent.txt" }] }];
  assert.equal(hasUnsentDraft(document), true);
  inputs = [];
  assert.equal(hasUnsentDraft(document), false);
});
test("epoch changes reload the actual UI once; steady polling does not cause a reload storm", async () => {
  const h = harness();
  await h.controller.refresh();
  assert.equal(h.reloads.length, 0);
  h.packet = ready("epoch-2");
  await h.controller.refresh();
  for (let i = 0; i < 20; i++) await h.controller.refresh();
  assert.equal(h.reloads.length, 1);
  assert.equal(h.reloads[0].epoch, "epoch-2");
});
test("network recovery with the same epoch reloads once after an actual down-to-ready transition", async () => {
  const h = harness();
  await h.controller.refresh();
  h.packet = Error("offline");
  await h.controller.refresh();
  assert.equal(h.controller.state.disconnected, true);
  h.packet = ready();
  await h.controller.refresh();
  await h.controller.refresh();
  assert.equal(h.reloads.length, 1);
});
test("recovery never discards a draft and refreshes only after the draft is deliberately cleared", async () => {
  const h = harness();
  await h.controller.refresh();
  h.draft = true;
  h.packet = ready("epoch-2", {
    uncertainOperations: [{ id: "pending-send" }],
  });
  await h.controller.refresh();
  await h.controller.refresh();
  assert.equal(h.reloads.length, 0);
  assert.equal(h.notices.at(-1).kind, "draft");
  assert.equal(h.draft, true);
  assert.equal(h.controller.state.pending, true);
  h.draft = false;
  await h.controller.refresh();
  await h.controller.refresh();
  assert.equal(h.reloads.length, 1);
});
test("authorization and native readiness failures wait rather than reload or replay an uncertain operation", async () => {
  const h = harness();
  await h.controller.refresh();
  h.packet = { ok: false, epoch: "epoch-2", httpStatus: 401 };
  await h.controller.refresh();
  assert.equal(h.notices.at(-1).kind, "authorization");
  assert.equal(h.reloads.length, 0);
  h.packet = {
    ...ready("epoch-2"),
    httpStatus: 503,
    ok: false,
    connection: { state: "disconnected", nativeReady: false },
  };
  await h.controller.refresh();
  assert.equal(h.reloads.length, 0);
  h.packet = ready("epoch-2", {
    uncertainOperations: [
      { id: "write-with-unknown-result", method: "turn/start" },
    ],
  });
  await h.controller.refresh();
  await h.controller.refresh();
  assert.equal(h.reloads.length, 1);
  assert.equal(h.notices.at(-1).kind, "uncertain");
});
test("a response for a previous hash is not applied to the newly selected conversation", async () => {
  let complete;
  const calls = [],
    reloads = [];
  let thread = "old-thread";
  const controller = createRecoveryController({
    fetchSnapshot: (id) => {
      calls.push(id);
      return id === "old-thread"
        ? new Promise((resolve) => (complete = resolve))
        : Promise.resolve(ready("new-epoch"));
    },
    getThreadId: () => thread,
    hasDraft: () => false,
    reload: (value) => reloads.push(value),
    notify: () => {},
  });
  const request = controller.refresh();
  thread = "new-thread";
  complete(ready("old-epoch"));
  await request;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["old-thread", "new-thread"]);
  assert.equal(controller.state.epoch, "new-epoch");
  assert.equal(reloads.length, 0);
  controller.stop();
});
test("stopping a recovery controller prevents an in-flight response from reloading", async () => {
  let complete;
  const reloads = [];
  const controller = createRecoveryController({
    fetchSnapshot: () => new Promise((resolve) => (complete = resolve)),
    getThreadId: () => "thread",
    hasDraft: () => false,
    reload: (x) => reloads.push(x),
    notify: () => {},
  });
  controller.markDisconnected();
  const request = controller.refresh();
  controller.stop();
  complete(ready());
  await request;
  assert.equal(reloads.length, 0);
});
test("steady polling requests lightweight probes and fetches history only on a recovery transition", async () => {
  const calls = [];
  let packet = ready();
  const controller = createRecoveryController({
    fetchSnapshot: async (id, options) => {
      calls.push({ id, ...options });
      return packet;
    },
    getThreadId: () => "thread",
    hasDraft: () => true,
    reload: () => assert.fail("draft must be retained"),
    notify: () => {},
  });
  await controller.refresh();
  for (let i = 0; i < 5; i++) await controller.refresh();
  assert.equal(calls.filter((call) => !call.probe).length, 0);
  packet = ready("epoch-2");
  await controller.refresh();
  for (let i = 0; i < 5; i++) await controller.refresh();
  assert.equal(calls.filter((call) => !call.probe).length, 1);
  assert(calls.every((call) => call.id === "thread"));
  controller.stop();
});
test("a failed full snapshot cannot turn a successful probe into a ready UI", async () => {
  let packet = ready();
  const reloads = [];
  const controller = createRecoveryController({
    fetchSnapshot: async (_id, options) =>
      options.probe ? packet : { ...packet, httpStatus: 503 },
    getThreadId: () => "thread",
    hasDraft: () => false,
    reload: (x) => reloads.push(x),
    notify: () => {},
  });
  await controller.refresh();
  packet = ready("epoch-2");
  await controller.refresh();
  assert.equal(reloads.length, 0);
  assert.equal(controller.state.disconnected, true);
  controller.stop();
});
test("the device overview also retrieves a full approval snapshot after recovery", async () => {
  const calls = [];
  const controller = createRecoveryController({
    fetchSnapshot: async (id, options) => {
      calls.push({ id, ...options });
      return ready();
    },
    getThreadId: () => "",
    hasDraft: () => false,
    reload: () => {},
    notify: () => {},
  });
  await controller.refresh();
  controller.markDisconnected("resume");
  await controller.refresh();
  assert.equal(calls.filter((call) => !call.probe).length, 1);
  assert(calls.every((call) => call.id === ""));
  controller.stop();
});

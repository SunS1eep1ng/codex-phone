import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationJournal } from "../src/operations.mjs";
import { saveJSON } from "../src/state.mjs";
test("operation metadata survives restart, never replays unknown writes and contains no prompt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codex-phone-operation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { deviceId: "isolated-operations" };
  const j = await OperationJournal.open(config, dir);
  let count = 0;
  await assert.rejects(
    j.run(
      "turn/start",
      { threadId: "same", input: [{ text: "SENSITIVE_TEST_PROMPT" }] },
      async () => {
        count++;
        throw Object.assign(Error("lost response"), {
          code: "native_outcome_unknown",
          outcomeUnknown: true,
        });
      },
      { requestId: "same-op" },
    ),
  );
  assert.equal(count, 1);
  assert.equal(j.list("same")[0].state, "uncertain");
  assert(
    !(await readFile(join(dir, "operations.json"), "utf8")).includes(
      "SENSITIVE_TEST_PROMPT",
    ),
  );
  const restarted = await OperationJournal.open(config, dir);
  await assert.rejects(
    restarted.run(
      "turn/start",
      { threadId: "same", input: [{ text: "SENSITIVE_TEST_PROMPT" }] },
      async () => {
        count++;
      },
      { requestId: "same-op" },
    ),
    { code: "operation_outcome_unknown" },
  );
  assert.equal(count, 1);
  await restarted.acknowledge("same-op");
  assert.equal(restarted.list().length, 0);
  await saveJSON(join(dir, "operations.json"), {
    schema: 1,
    deviceId: config.deviceId,
    operations: [
      {
        id: "interrupted",
        state: "pending",
        method: "turn/start",
        threadId: "same",
      },
    ],
  });
  const crash = await OperationJournal.open(config, dir);
  assert.equal(crash.list()[0].state, "uncertain");
  assert.equal(crash.list()[0].code, "service_restarted");
});
test("concurrent same-id writes run once and a known business rejection is not uncertain", async () => {
  const j = new OperationJournal({ schema: 1, operations: [] });
  let count = 0,
    release;
  const barrier = new Promise((r) => (release = r));
  const execute = async () => {
    count++;
    await barrier;
    return { turn: { id: "native-turn" } };
  };
  const a = j.run("turn/start", { threadId: "same" }, execute, {
    requestId: "op",
  });
  const b = j.run("turn/start", { threadId: "same" }, execute, {
    requestId: "op",
  });
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await a, await b);
  assert.equal(count, 1);
  assert.equal(j.list().length, 0);
  await assert.rejects(
    j.run(
      "turn/start",
      { threadId: "missing" },
      async () => {
        throw Object.assign(Error("thread not found"), {
          code: "native_rpc_error",
        });
      },
      { requestId: "reject" },
    ),
  );
  assert.equal(j.list().length, 0);
  assert.equal(j.data.operations.at(-1).state, "failed");
});
test("suspend fences writes still waiting for their first durable record", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let saves = 0,
    executions = 0;
  const j = new OperationJournal(
    { operations: [] },
    {
      save: async () => {
        if (++saves === 1) await gate;
      },
    },
  );
  const pending = j.run(
    "turn/start",
    { threadId: "same" },
    async () => executions++,
    { requestId: "delayed" },
  );
  const stopped = j.suspend();
  release();
  await assert.rejects(pending, { code: "service_stopping" });
  await stopped;
  assert.equal(executions, 0);
  await assert.rejects(
    j.run("turn/start", {}, async () => executions++, {
      requestId: "after-stop",
    }),
    { code: "service_stopping" },
  );
});
test("a post-dispatch journal failure preserves an uncertain outcome and known native turn id", async () => {
  let saves = 0,
    executions = 0;
  const j = new OperationJournal(
    { operations: [] },
    {
      save: async () => {
        if (++saves > 1)
          throw Object.assign(Error("disk full"), { code: "ENOSPC" });
      },
    },
  );
  await assert.rejects(
    j.run(
      "turn/start",
      { threadId: "same" },
      async () => {
        executions++;
        return { turn: { id: "known-native-turn" } };
      },
      { requestId: "disk-full" },
    ),
    (error) =>
      error.outcomeUnknown === true &&
      error.code === "operation_outcome_unknown",
  );
  assert.equal(executions, 1);
  assert.equal(j.list()[0].state, "uncertain");
  assert.equal(j.list()[0].turnId, "known-native-turn");
});

test("a new transport id cannot replay an identical uncertain turn before explicit review", async () => {
  const j = new OperationJournal({ operations: [] });
  let count = 0;
  const params = { threadId: "same", input: [{ text: "same intent" }] };
  await assert.rejects(
    j.run(
      "turn/start",
      params,
      async () => {
        count++;
        throw Object.assign(Error("lost response"), { outcomeUnknown: true });
      },
      { requestId: "original" },
    ),
  );
  await assert.rejects(
    j.run("turn/start", params, async () => count++, {
      requestId: "new-wire-id",
    }),
    { code: "operation_outcome_unknown" },
  );
  assert.equal(count, 1);
  await j.acknowledge("original");
  await j.run(
    "turn/start",
    params,
    async () => {
      count++;
      return { turn: { id: "explicit-resend" } };
    },
    { requestId: "after-review" },
  );
  assert.equal(count, 2);
});

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJSON, saveJSON, PhoneError } from "./state.mjs";

const WRITE_METHODS = new Set([
  "turn/start",
  "turn/interrupt",
  "thread/start",
  "thread/fork",
  "thread/rollback",
  "thread/archive",
  "thread/unarchive",
  "thread/name/set",
  "codex-web/local/server-requests/respond",
]);
export class OperationJournal {
  constructor(data, { save = async () => {}, now = Date.now } = {}) {
    this.data = data;
    this.save = save;
    this.now = now;
    this.active = new Map();
    this.queue = Promise.resolve();
    this.closing = false;
  }
  static async open(config, dir) {
    const file = join(dir, "operations.json");
    const data = await readJSON(file, {
      schema: 1,
      deviceId: config.deviceId,
      operations: [],
    });
    if (
      data.schema !== 1 ||
      data.deviceId !== config.deviceId ||
      !Array.isArray(data.operations)
    )
      throw new PhoneError("operations_state_invalid");
    const journal = new OperationJournal(data, {
      save: (data) => saveJSON(file, data),
    });
    let changed = false;
    for (const op of data.operations)
      if (op.state === "pending") {
        op.state = "uncertain";
        op.code = "service_restarted";
        changed = true;
      }
    if (changed) await journal.persist();
    return journal;
  }
  persist() {
    const snapshot = structuredClone(this.data);
    const write = this.queue.then(() => this.save(snapshot));
    this.queue = write.catch(() => {});
    return write;
  }
  list(threadId) {
    return this.data.operations
      .filter(
        (o) =>
          (!threadId || !o.threadId || o.threadId === threadId) &&
          ["pending", "uncertain"].includes(o.state),
      )
      .map(({ hash, ...safe }) => safe);
  }
  async acknowledge(id) {
    const op = this.data.operations.find((o) => o.id === id);
    if (!op) throw new PhoneError("operation_not_found");
    if (op.state === "pending") throw new PhoneError("operation_still_pending");
    if (op.state === "uncertain") {
      op.state = "acknowledged";
      op.updatedAt = this.now();
      await this.persist();
    }
    return { ok: true };
  }
  async suspend() {
    this.closing = true;
    for (const op of this.data.operations)
      if (op.state === "pending") {
        op.state = "uncertain";
        op.code = "service_stopping";
        op.updatedAt = this.now();
      }
    await this.persist();
  }
  async run(method, params, execute, { requestId = randomUUID() } = {}) {
    if (!WRITE_METHODS.has(method)) return execute();
    if (this.closing)
      throw new PhoneError(
        "service_stopping",
        "No new write is started while the service is stopping.",
      );
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))
      throw new PhoneError("operation_id_invalid");
    const hash = createHash("sha256")
      .update(JSON.stringify([method, params]))
      .digest("hex");
    const previous = this.data.operations.find((o) => o.id === requestId);
    if (previous) {
      if (previous.hash !== hash) throw new PhoneError("operation_id_conflict");
      if (this.active.has(requestId)) return this.active.get(requestId);
      throw new PhoneError(
        previous.state === "completed"
          ? "operation_already_completed"
          : "operation_outcome_unknown",
        "Check the native conversation before deciding whether to send a new request.",
      );
    }
    if (
      method === "turn/start" &&
      this.data.operations.some(
        (op) => op.hash === hash && ["pending", "uncertain"].includes(op.state),
      )
    )
      throw new PhoneError(
        "operation_outcome_unknown",
        "An identical turn is still pending or uncertain. Check the conversation and acknowledge its record before submitting it again.",
      );
    // Keep unresolved operations until explicitly reconciled; prune only finished metadata.
    if (this.data.operations.length >= 2000) {
      const finished = this.data.operations.filter(
        (o) => !["pending", "uncertain"].includes(o.state),
      );
      const remove = new Set(
        finished
          .slice(0, Math.max(0, this.data.operations.length - 1500))
          .map((o) => o.id),
      );
      this.data.operations = this.data.operations.filter(
        (o) => !remove.has(o.id),
      );
      if (this.data.operations.length >= 2000)
        throw new PhoneError(
          "operations_queue_full",
          "Reconcile unresolved operations before starting more writes.",
        );
    }
    const op = {
      id: requestId,
      method,
      threadId: typeof params?.threadId === "string" ? params.threadId : null,
      hash,
      state: "pending",
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    this.data.operations.push(op);
    const task = (async () => {
      let dispatched = false,
        completed = false;
      try {
        await this.persist();
        if (this.closing) throw new PhoneError("service_stopping");
        dispatched = true;
        const result = await execute();
        completed = true;
        op.state = "completed";
        op.updatedAt = this.now();
        const turnId = result?.turn?.id;
        if (typeof turnId === "string") op.turnId = turnId;
        if (typeof result?.thread?.id === "string")
          op.threadId = result.thread.id;
        await this.persist();
        return result;
      } catch (e) {
        const unknown =
          completed ||
          (dispatched &&
            (e.outcomeUnknown ||
              /transport|outcome_unknown|timeout|disconnect|context|ECONN|AbortError/i.test(
                String(e.code || "") + " " + e.message,
              )));
        op.state = unknown ? "uncertain" : "failed";
        op.code = completed
          ? "operation_result_not_persisted"
          : e.code || "native_error";
        op.updatedAt = this.now();
        await this.persist().catch(() => {});
        if (completed) {
          const failure = new PhoneError(
            "operation_outcome_unknown",
            "The native request returned, but its result metadata could not be saved. Check the conversation before resending.",
          );
          failure.outcomeUnknown = true;
          failure.turnId = op.turnId;
          throw failure;
        }
        throw e;
      } finally {
        this.active.delete(requestId);
      }
    })();
    this.active.set(requestId, task);
    return task;
  }
}

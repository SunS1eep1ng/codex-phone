import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { localOperation } from "./local-ops.mjs";
const MAX_FRAME_BYTES = 1024 * 1024;
const PROTOCOL_RESPONSE_BYTES = 256 * 1024 * 1024;
const errorWithCode = (code, message) =>
  Object.assign(new Error(message), { code });
function serializeResponse(response, maxBytes) {
  const data = Buffer.from(JSON.stringify(response));
  if (data.length > maxBytes)
    throw errorWithCode("response_too_large", "AGENT_RESPONSE_TOO_LARGE");
  return data;
}
function* responseFrames(data, id, chunkSize = 512 * 1024) {
  if (data.length <= chunkSize) {
    yield data.toString();
    return;
  }
  const total = Math.ceil(data.length / chunkSize);
  for (let index = 0; index < total; index++) {
    yield JSON.stringify({
      version: 1,
      type: "response/chunk",
      id,
      index,
      total,
      encoding: "base64-json",
      data: data
        .subarray(index * chunkSize, (index + 1) * chunkSize)
        .toString("base64"),
    });
  }
}
// Kept as a small protocol utility. Production sending consumes the generator lazily.
export function encodeResponse(response, chunkSize = 512 * 1024) {
  return [
    ...responseFrames(
      serializeResponse(response, PROTOCOL_RESPONSE_BYTES),
      response.id,
      chunkSize,
    ),
  ];
}
export class LocalAgent extends EventEmitter {
  constructor(config, driver, options = {}) {
    super();
    this.config = config;
    this.driver = driver;
    this.options = {
      createSocket: (url, options) => new WebSocket(url, options),
      reconnectDelayMs: 2000,
      maxQueueBytes: 4 * 1024 * 1024,
      maxSocketBufferedBytes: 1024 * 1024,
      maxResponseBytes: 64 * 1024 * 1024,
      maxCachedBytes: 16 * 1024 * 1024,
      maxInflight: 8,
      sendTimeoutMs: 15000,
      ...options,
    };
    this.stopped = false;
    this.connected = false;
    this.sequence = 0;
    this.generation = 0;
    this.instanceId =
      (config.deviceId || "local") + ":" + randomBytes(6).toString("hex");
    this.epoch = this.instanceId + ":0";
    this.cache = new Map();
    this.cacheBytes = 0;
    this.completed = new Map();
    this.inflight = new Map();
    this.queues = new Map();
    this.timer = null;
    this.needsResync = true;
    this.onEvent = (event) => {
      if (!this.connected) {
        this.needsResync = true;
        return;
      }
      void this.send({
        version: 1,
        type: "event",
        sequence: ++this.sequence,
        event,
      }).catch(() => {});
    };
    this.onReady = (event) => {
      if (this.connected) {
        this.needsResync = false;
        this.emit("resync", {
          reason: "native-ready",
          epoch: event?.epoch || driver.epoch,
          agentEpoch: this.epoch,
        });
      } else this.needsResync = true;
    };
    this.onNativeDisconnect = (event) =>
      this.requireResync("native-disconnected", { nativeEpoch: event?.epoch });
    this.attachDriver();
  }
  attachDriver() {
    if (this.driverAttached) return;
    this.driver.on("event", this.onEvent);
    this.driver.on("ready", this.onReady);
    this.driver.on("disconnect", this.onNativeDisconnect);
    this.driverAttached = true;
  }
  requireResync(reason, details = {}) {
    if (this.needsResync) return;
    this.needsResync = true;
    this.emit("resync-needed", {
      reason,
      epoch: this.driver.epoch,
      agentEpoch: this.epoch,
      ...details,
    });
  }
  markDisconnected(ws, reason) {
    if (this.ws !== ws) return;
    this.connected = false;
    this.requireResync(reason);
    if (this.disconnectNotified) return;
    this.disconnectNotified = true;
    this.emit("disconnect", {
      reason,
      epoch: this.driver.epoch,
      agentEpoch: this.epoch,
    });
  }
  queueFor(ws) {
    let queue = this.queues.get(ws);
    if (queue) return queue;
    queue = { items: [], active: null, bytes: 0, closed: false, poll: null };
    this.queues.set(ws, queue);
    ws.once?.("close", () =>
      this.closeQueue(
        ws,
        errorWithCode("agent_disconnected", "Agent transport disconnected."),
      ),
    );
    return queue;
  }
  closeQueue(ws, error) {
    const queue = this.queues.get(ws);
    if (!queue || queue.closed) return;
    queue.closed = true;
    clearTimeout(queue.poll);
    if (queue.active) {
      clearTimeout(queue.active.timer);
      queue.active.reject(error);
      queue.active = null;
    }
    for (const item of queue.items) item.reject(error);
    queue.items.length = 0;
    queue.bytes = 0;
    this.queues.delete(ws);
  }
  disconnectForResync(ws, reason) {
    const error = errorWithCode("agent_backpressure", reason);
    this.requireResync(reason);
    this.closeQueue(ws, error);
    this.markDisconnected(ws, reason);
    try {
      ws.close(1013, reason.slice(0, 120));
    } finally {
      ws.terminate?.();
    }
    return error;
  }
  send(message, ws = this.ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN || this.stopped)
      return Promise.reject(
        errorWithCode(
          "agent_disconnected",
          "Agent transport is not connected.",
        ),
      );
    const frame =
      typeof message === "string" ? message : JSON.stringify(message);
    const bytes = Buffer.byteLength(frame);
    if (bytes > MAX_FRAME_BYTES)
      return Promise.reject(
        this.disconnectForResync(
          ws,
          "Agent frame too large; state resynchronization required.",
        ),
      );
    const queue = this.queueFor(ws);
    if (
      queue.bytes + bytes + (ws.bufferedAmount || 0) >
      this.options.maxQueueBytes
    )
      return Promise.reject(
        this.disconnectForResync(
          ws,
          "Agent send queue exceeded its byte limit; state resynchronization required.",
        ),
      );
    return new Promise((resolve, reject) => {
      queue.items.push({
        frame,
        bytes,
        resolve,
        reject,
        deadline: Date.now() + this.options.sendTimeoutMs,
      });
      queue.bytes += bytes;
      this.pump(ws, queue);
    });
  }
  pump(ws, queue) {
    if (queue.closed || queue.active || !queue.items.length) return;
    if (ws.readyState !== WebSocket.OPEN) {
      this.closeQueue(
        ws,
        errorWithCode("agent_disconnected", "Agent transport disconnected."),
      );
      return;
    }
    const item = queue.items[0];
    if (Date.now() >= item.deadline) {
      this.disconnectForResync(
        ws,
        "Agent consumer stopped draining; state resynchronization required.",
      );
      return;
    }
    if ((ws.bufferedAmount || 0) > this.options.maxSocketBufferedBytes) {
      if (!queue.poll)
        queue.poll = setTimeout(() => {
          queue.poll = null;
          this.pump(ws, queue);
        }, 20);
      return;
    }
    queue.items.shift();
    queue.active = item;
    item.timer = setTimeout(
      () =>
        this.disconnectForResync(
          ws,
          "Agent send timed out; state resynchronization required.",
        ),
      Math.max(1, item.deadline - Date.now()),
    );
    const done = (error) => {
      if (queue.closed || queue.active !== item) return;
      clearTimeout(item.timer);
      queue.active = null;
      queue.bytes -= item.bytes;
      if (error) {
        item.reject(error);
        this.disconnectForResync(
          ws,
          "Agent send failed; state resynchronization required.",
        );
        return;
      }
      item.resolve();
      this.pump(ws, queue);
    };
    try {
      ws.send(item.frame, done);
    } catch (error) {
      done(error);
    }
  }
  start(port) {
    this.port = port;
    this.stopped = false;
    this.attachDriver();
    this.connect();
  }
  connect() {
    if (
      this.stopped ||
      [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws?.readyState)
    )
      return;
    clearTimeout(this.timer);
    this.timer = null;
    const epoch = this.instanceId + ":" + ++this.generation;
    this.epoch = epoch;
    const ws = this.options.createSocket(
      `ws://127.0.0.1:${this.port}/codex-api/agent/ws`,
      {
        headers: { authorization: "Bearer " + this.config.agentSecret },
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: 5000,
      },
    );
    this.ws = ws;
    this.connected = false;
    this.disconnectNotified = false;
    ws.on("error", () => {
      this.markDisconnected(ws, "agent-transport-error");
    });
    ws.on("open", () => {
      if (this.stopped || this.ws !== ws) {
        ws.terminate?.();
        return;
      }
      this.sequence = 0;
      void this.send(
        {
          version: 1,
          type: "hello",
          deviceId: this.config.deviceId,
          deviceName: this.config.deviceName,
          agentVersion:
            "codex-phone/" + (this.config.projectVersion || "development"),
          capabilities: ["rpc", "events", "bridge/status"],
        },
        ws,
      ).catch(() => {});
    });
    ws.on("message", (raw) => {
      if (this.stopped || this.ws !== ws) return;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        ws.close(1008, "Invalid JSON");
        return;
      }
      if (message.version !== 1) {
        ws.close(1008, "Protocol");
        return;
      }
      if (message.type === "hello/ack") {
        if (message.accepted !== true) {
          ws.close(1008, "Agent hello rejected");
          return;
        }
        if (!this.connected) {
          this.connected = true;
          this.disconnectNotified = false;
          this.needsResync = false;
          this.emit("resync", {
            reason: "agent-connected",
            epoch: this.driver.epoch,
            agentEpoch: epoch,
          });
        }
        return;
      }
      if (!this.connected) {
        ws.close(1008, "Hello acknowledgement required");
        return;
      }
      if (message.type === "ping")
        void this.send(
          { version: 1, type: "pong", nonce: message.nonce },
          ws,
        ).catch(() => {});
      if (message.type === "request")
        void this.respond(message, ws).catch(() =>
          this.disconnectForResync(
            ws,
            "Agent response failed; state resynchronization required.",
          ),
        );
    });
    ws.on("close", () => {
      this.closeQueue(
        ws,
        errorWithCode("agent_disconnected", "Agent transport disconnected."),
      );
      if (this.ws !== ws) return;
      this.markDisconnected(ws, "agent-disconnected");
      if (!this.stopped)
        this.timer = setTimeout(
          () => this.connect(),
          this.options.reconnectDelayMs,
        );
    });
  }
  async execute(message) {
    if (message.method === "bridge/status") return this.driver.health();
    if (message.method !== "rpc" || typeof message.params?.method !== "string")
      throw errorWithCode("invalid_agent_request", "INVALID_AGENT_REQUEST");
    const method = message.params.method;
    if (
      method.startsWith("codex-web/local/") &&
      !method.startsWith("codex-web/local/server-requests/")
    )
      return localOperation(method, message.params.params);
    return this.driver.rpc(method, message.params.params, {
      requestId: message.id,
    });
  }
  async finishRequest(message, entry) {
    let response;
    try {
      response = {
        version: 1,
        type: "response",
        id: message.id,
        ok: true,
        result: await this.execute(message),
      };
    } catch (error) {
      response = {
        version: 1,
        type: "response",
        id: message.id,
        ok: false,
        error: {
          code: error.code || "native_error",
          message: error.message,
          ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}),
        },
      };
    }
    try {
      entry.data = serializeResponse(response, this.options.maxResponseBytes);
    } catch (error) {
      entry.data = serializeResponse(
        {
          version: 1,
          type: "response",
          id: message.id,
          ok: false,
          error: { code: "response_too_large", message: error.message },
        },
        MAX_FRAME_BYTES,
      );
    }
    this.inflight.delete(message.id);
    this.completed.set(message.id, entry.signature);
    while (this.completed.size > 2048)
      this.completed.delete(this.completed.keys().next().value);
    this.cache.set(message.id, entry);
    this.cacheBytes += entry.data.length;
    while (
      this.cache.size > 32 ||
      this.cacheBytes > this.options.maxCachedBytes
    ) {
      const id = this.cache.keys().next().value;
      this.cacheBytes -= this.cache.get(id).data.length;
      this.cache.delete(id);
    }
    return entry;
  }
  async respond(message, ws) {
    if (
      typeof message.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(message.id)
    ) {
      ws.close(1008, "Invalid request id");
      return;
    }
    const signature = JSON.stringify([message.method, message.params]);
    let entry = this.cache.get(message.id) || this.inflight.get(message.id);
    const recordedSignature =
      entry?.signature || this.completed.get(message.id);
    if (recordedSignature && recordedSignature !== signature) {
      ws.close(1008, "Duplicate id changed payload");
      return;
    }
    if (!entry && this.completed.has(message.id)) {
      await this.send(
        {
          version: 1,
          type: "response",
          id: message.id,
          ok: false,
          error: {
            code: "already_processed",
            message:
              "The original request was processed; its response is no longer cached. Query its state; do not replay a write with a new id.",
          },
        },
        ws,
      ).catch(() => {});
      return;
    }
    if (!entry) {
      if (this.inflight.size >= this.options.maxInflight) {
        ws.close(1013, "Too many native requests");
        return;
      }
      entry = { signature, promise: null, data: null };
      this.inflight.set(message.id, entry);
      entry.promise = this.finishRequest(message, entry);
    }
    await entry.promise;
    if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
    try {
      for (const frame of responseFrames(entry.data, message.id))
        await this.send(frame, ws);
    } catch {
      this.requireResync("agent-response-interrupted");
    }
  }
  stop() {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.timer);
    this.timer = null;
    for (const ws of this.queues.keys())
      this.closeQueue(
        ws,
        errorWithCode(
          "agent_stopped",
          "Agent stopped; pending operations must not be replayed.",
        ),
      );
    this.markDisconnected(this.ws, "stopped");
    this.ws?.terminate?.();
    this.ws?.close?.();
    this.driver.off("event", this.onEvent);
    this.driver.off("ready", this.onReady);
    this.driver.off("disconnect", this.onNativeDisconnect);
    this.driverAttached = false;
  }
}

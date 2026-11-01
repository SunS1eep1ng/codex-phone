import WebSocket from "ws";
import { localOperation } from "./local-ops.mjs";
export function encodeResponse(response, chunkSize = 512 * 1024) {
  const data = Buffer.from(JSON.stringify(response));
  if (data.length > 256 * 1024 * 1024) throw Error("AGENT_RESPONSE_TOO_LARGE");
  if (data.length <= chunkSize) return [JSON.stringify(response)];
  const total = Math.ceil(data.length / chunkSize);
  return Array.from({ length: total }, (_, index) =>
    JSON.stringify({
      version: 1,
      type: "response/chunk",
      id: response.id,
      index,
      total,
      encoding: "base64-json",
      data: data
        .subarray(index * chunkSize, (index + 1) * chunkSize)
        .toString("base64"),
    }),
  );
}
export class LocalAgent {
  constructor(config, driver) {
    this.config = config;
    this.driver = driver;
    this.stopped = false;
    this.sequence = 0;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.completed = new Map();
    this.inflight = new Map();
    this.timer = null;
    this.onEvent = (event) =>
      this.send({
        version: 1,
        type: "event",
        sequence: ++this.sequence,
        event,
      });
    driver.on("event", this.onEvent);
  }
  send(m) {
    if (this.ws?.readyState !== 1) return;
    const frame = JSON.stringify(m);
    if (Buffer.byteLength(frame) > 1024 * 1024) {
      this.ws.close(
        1009,
        "Agent event exceeds frame limit; refresh native history.",
      );
      return;
    }
    this.ws.send(frame);
  }
  start(port) {
    this.port = port;
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/codex-api/agent/ws`, {
      headers: { authorization: "Bearer " + this.config.agentSecret },
      maxPayload: 1024 * 1024,
      handshakeTimeout: 5000,
    });
    this.ws = ws;
    ws.on("error", () => {});
    ws.on("open", () => {
      this.sequence = 0;
      this.send({
        version: 1,
        type: "hello",
        deviceId: this.config.deviceId,
        deviceName: this.config.deviceName,
        agentVersion: "codex-phone/0.1.0",
        capabilities: ["rpc", "events", "bridge/status"],
      });
    });
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return ws.close(1008, "Invalid JSON");
      }
      if (m.version !== 1) return ws.close(1008, "Protocol");
      if (m.type === "ping")
        this.send({ version: 1, type: "pong", nonce: m.nonce });
      if (m.type === "request") void this.respond(m, ws);
    });
    ws.on("close", () => {
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), 2000);
    });
  }
  async execute(m) {
    if (m.method === "bridge/status") return this.driver.health();
    if (m.method !== "rpc" || typeof m.params?.method !== "string")
      throw Error("INVALID_AGENT_REQUEST");
    const method = m.params.method;
    if (
      method.startsWith("codex-web/local/") &&
      !method.startsWith("codex-web/local/server-requests/")
    )
      return localOperation(method, m.params.params);
    return this.driver.rpc(method, m.params.params);
  }
  async respond(m, ws) {
    if (typeof m.id !== "string" || m.id.length > 256)
      return ws.close(1008, "Invalid request id");
    const signature = JSON.stringify([m.method, m.params]);
    if (
      !this.cache.has(m.id) &&
      !this.inflight.has(m.id) &&
      this.completed.has(m.id)
    ) {
      if (this.completed.get(m.id) !== signature)
        return ws.close(1008, "Duplicate id changed payload");
      if (ws.readyState === 1)
        ws.send(
          JSON.stringify({
            version: 1,
            type: "response",
            id: m.id,
            ok: false,
            error: {
              code: "already_processed",
              message:
                "The original request was processed; its response is no longer cached. Do not replay a turn with a new id.",
            },
          }),
        );
      return;
    }
    const cached = this.cache.get(m.id);
    if (cached && cached.signature !== signature)
      return ws.close(1008, "Duplicate id changed payload");
    let entry = cached || this.inflight.get(m.id);
    if (entry && entry.signature !== signature)
      return ws.close(1008, "Duplicate id changed payload");
    if (!entry) {
      if (this.inflight.size >= 32) return ws.close(1013, "Busy");
      entry = {
        signature,
        promise: (async () => {
          try {
            return {
              version: 1,
              type: "response",
              id: m.id,
              ok: true,
              result: await this.execute(m),
            };
          } catch (e) {
            return {
              version: 1,
              type: "response",
              id: m.id,
              ok: false,
              error: { code: e.code || "native_error", message: e.message },
            };
          }
        })(),
      };
      this.inflight.set(m.id, entry);
    }
    const response = await entry.promise;
    this.inflight.delete(m.id);
    if (!this.cache.has(m.id)) {
      entry.bytes = Buffer.byteLength(JSON.stringify(response));
      this.cache.set(m.id, entry);
      this.cacheBytes += entry.bytes;
      this.completed.set(m.id, signature);
      while (this.completed.size > 2048)
        this.completed.delete(this.completed.keys().next().value);
      while (this.cache.size > 32 || this.cacheBytes > 32 * 1024 * 1024) {
        const id = this.cache.keys().next().value;
        this.cacheBytes -= this.cache.get(id).bytes;
        this.cache.delete(id);
      }
    }
    let frames;
    try {
      frames = encodeResponse(response);
    } catch (e) {
      frames = encodeResponse({
        version: 1,
        type: "response",
        id: m.id,
        ok: false,
        error: { code: "response_too_large", message: e.message },
      });
    }
    if (ws.readyState === 1) for (const frame of frames) ws.send(frame);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.driver.off("event", this.onEvent);
  }
}

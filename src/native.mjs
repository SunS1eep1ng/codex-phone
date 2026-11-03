import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
  CODEX_DESKTOP_ADAPTER_GLOBAL as namespace,
  createRendererBootstrapSource,
  createRendererCommandSource,
  createRendererDisposeSource,
} from "./renderer-bootstrap.ts";
import { PhoneError } from "./state.mjs";
import {
  discoverServiceModules,
  createServiceManagerSource,
} from "./desktop-service.mjs";
const contextLost = (error) =>
  /Execution context (?:was )?destroyed|Cannot find (?:default execution )?context|adapter is not installed|Compatible native Desktop manager required|Target closed|Session closed/i.test(
    error?.message || "",
  );
const transportLost = (error) =>
  [
    "cdp_disconnected",
    "cdp_timeout",
    "cdp_send_failed",
    "native_context_lost",
  ].includes(error?.code) || contextLost(error);
const codedError = (code, message) =>
  Object.assign(new Error(message), { code });
const cancelled = () =>
  codedError(
    "native_connection_cancelled",
    "Native connection lifecycle was cancelled.",
  );
function settleWithin(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise.catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
export class CDP extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.pending = new Map();
    this.id = 0;
    this.closed = false;
    ws.on("message", (b) => {
      let m;
      try {
        m = JSON.parse(b);
      } catch {
        return;
      }
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        m.error
          ? p.reject(
              codedError(
                contextLost(m.error)
                  ? "native_context_lost"
                  : "cdp_protocol_error",
                m.error.message,
              ),
            )
          : p.resolve(m.result);
      } else this.emit("event", m);
    });
    ws.on("error", (error) =>
      this.finishClose(codedError("cdp_disconnected", error.message)),
    );
    ws.on("close", () =>
      this.finishClose(codedError("cdp_disconnected", "CDP_DISCONNECTED")),
    );
  }
  static async open(url, { signal } = {}) {
    signal?.throwIfAborted();
    const ws = new WebSocket(url, {
      maxPayload: 256 * 1024 * 1024,
      handshakeTimeout: 8000,
    });
    await new Promise((yes, no) => {
      const finish = (fn, value) => {
        signal?.removeEventListener("abort", onAbort);
        ws.off("open", onOpen);
        ws.off("error", onError);
        fn(value);
      };
      const onOpen = () => finish(yes);
      const onError = (error) => finish(no, error);
      const onAbort = () => {
        ws.once("error", () => {});
        ws.terminate();
        finish(no, signal.reason || cancelled());
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return new CDP(ws);
  }
  call(method, params = {}, timeout = 45000) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(codedError("cdp_disconnected", "CDP_DISCONNECTED"));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codedError("cdp_timeout", "CDP_TIMEOUT: " + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const failed = (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(codedError("cdp_send_failed", error.message));
      };
      try {
        this.ws.send(JSON.stringify({ id, method, params }), failed);
      } catch (error) {
        failed(error);
      }
    });
  }
  async evaluate(
    expression,
    byValue = true,
    { timeoutMs = 45000, objectGroup = namespace } = {},
  ) {
    const r = await this.call(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: byValue,
        objectGroup,
      },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const message =
        r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw codedError(
        contextLost({ message }) ? "native_context_lost" : "native_rpc_error",
        message,
      );
    }
    return byValue ? r.result?.value : r.result;
  }
  close() {
    this.finishClose(codedError("cdp_disconnected", "CDP_DISCONNECTED"));
    this.ws.terminate();
  }
  finishClose(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnect", error);
  }
}
export class NativeDriver extends EventEmitter {
  constructor({
    port,
    verify = async () => {},
    fetchTargets,
    connectClient = CDP.open,
    closeTimeoutMs = 1500,
    requestTimeoutMs = 45000,
  }) {
    super();
    this.port = port;
    this.verify = verify;
    this.client = null;
    this.connecting = null;
    this.state = "disconnected";
    this.error = null;
    this.baseNamespace = namespace + "_" + randomBytes(6).toString("hex");
    this.generation = 0;
    this.epoch = this.baseNamespace + ":0";
    this.clientNamespace = null;
    this.clientGeneration = null;
    this.pendingClients = new Map();
    this.connectAbort = null;
    this.fetchTargets =
      fetchTargets ||
      (async (port, signal) => {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        if (!r.ok) throw Error("NATIVE_DISCOVERY_HTTP_" + r.status);
        return r.json();
      });
    this.connectClient = connectClient;
    this.closeTimeoutMs = closeTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
  }
  async connect() {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    this.epoch = this.baseNamespace + ":" + generation;
    const abort = new AbortController();
    this.connectAbort = abort;
    this.state = "connecting";
    const promise = this.open(generation, abort.signal);
    this.connecting = promise;
    try {
      await promise;
    } finally {
      if (this.connecting === promise) {
        this.connecting = null;
        this.connectAbort = null;
      }
    }
  }
  async open(generation, signal) {
    let c;
    const adapterNamespace = this.baseNamespace + "_generation_" + generation;
    const current = () => {
      if (signal.aborted || generation !== this.generation) throw cancelled();
      if (c?.closed) throw codedError("cdp_disconnected", "CDP_DISCONNECTED");
    };
    const evaluate = (expression, byValue = true) =>
      c.evaluate(expression, byValue, {
        timeoutMs: this.requestTimeoutMs,
        objectGroup: adapterNamespace,
      });
    try {
      await this.verify(this.port);
      current();
      const targets = await this.fetchTargets(this.port, signal);
      current();
      const target = targets.find(
        (t) => t.type === "page" && t.url === "app://-/index.html",
      );
      if (!target) throw Error("NATIVE_RENDERER_NOT_FOUND");
      const ws = new URL(target.webSocketDebuggerUrl);
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(ws.hostname) ||
        Number(ws.port) !== this.port
      )
        throw Error("CDP_NOT_LOOPBACK");
      c = await this.connectClient(ws.href, { signal });
      this.pendingClients.set(generation, c);
      current();
      await c.call("Runtime.enable");
      current();
      const binding = adapterNamespace + "_event";
      await c.call("Runtime.addBinding", { name: binding });
      current();
      const moduleUrls = await discoverServiceModules(c);
      current();
      const service = moduleUrls.length
        ? await evaluate(
            createServiceManagerSource({
              moduleUrls,
              managerKey: adapterNamespace + "_manager",
              familyNamespace: this.baseNamespace,
              generation,
            }),
          )
        : null;
      current();
      if (service?.kind !== "desktop-service-rpc") {
        const prototype = await evaluate(
          `(async()=>{const required=['getHostId','getConversation','sendRequest','addApprovalRequestListener','addNotificationCallback','addTurnCompletedListener','addStreamRoleStateCallback'];let url;for(const script of document.querySelectorAll('script[src]')){const source=await(await fetch(script.src)).text();const match=source.match(/app-initial-[a-z0-9]+\\.js/);if(match){url=new URL(match[0],script.src).href;break;}}if(!url)throw Error('UNSUPPORTED_DESKTOP_MODULE');const module=await import(url);const type=Object.values(module).find(v=>typeof v==='function'&&v.prototype&&required.every(k=>typeof v.prototype[k]==='function'));if(!type)throw Error('UNSUPPORTED_DESKTOP_MANAGER');return type.prototype;})()`,
          false,
        );
        current();
        if (!prototype?.objectId) throw Error("UNSUPPORTED_DESKTOP_MANAGER");
        const objects = await c.call("Runtime.queryObjects", {
          prototypeObjectId: prototype.objectId,
          objectGroup: adapterNamespace,
        });
        current();
        await c.call("Runtime.callFunctionOn", {
          objectId: objects.objects.objectId,
          functionDeclaration: `function(){const manager=this.find(v=>!v.disposed&&v.getHostId()==='local');if(!manager)throw Error('NATIVE_MANAGER_MISSING');globalThis[${JSON.stringify(adapterNamespace + "_manager")}]=manager;return true;}`,
          returnByValue: true,
        });
      }
      current();
      c.on("event", (m) => {
        if (
          generation === this.generation &&
          m.method === "Runtime.bindingCalled" &&
          m.params.name === binding
        ) {
          try {
            this.emit("event", JSON.parse(m.params.payload));
          } catch {}
        }
      });
      const hello = await evaluate(
        createRendererBootstrapSource(binding, adapterNamespace, {
          familyNamespace: this.baseNamespace,
          generation,
        }),
      );
      current();
      if (hello?.protocol !== 1 || hello.hostId !== "local")
        throw Error("NATIVE_CAPABILITY_MISMATCH");
      await c.call("Runtime.releaseObjectGroup", {
        objectGroup: adapterNamespace,
      });
      current();
      this.client = c;
      this.clientNamespace = adapterNamespace;
      this.clientGeneration = generation;
      this.pendingClients.delete(generation);
      this.state = "ready";
      this.error = null;
      c.on("disconnect", (error) => {
        if (this.client === c && generation === this.generation) {
          this.client = null;
          this.clientNamespace = null;
          this.clientGeneration = null;
          this.state = "disconnected";
          this.error = error?.message || "CDP_DISCONNECTED";
          this.emit("disconnect", {
            epoch: this.epoch,
            reason: "transport-disconnected",
            error: this.error,
          });
        }
      });
      this.emit("ready", { epoch: this.epoch, state: "ready" });
    } catch (e) {
      c?.close();
      if (this.client === c) {
        this.client = null;
        this.clientNamespace = null;
        this.clientGeneration = null;
      }
      this.pendingClients.delete(generation);
      if (signal.aborted || generation !== this.generation) throw cancelled();
      this.state = "error";
      this.error = e.message;
      throw new PhoneError("desktop_unavailable", e.message, [
        "Run doctor; normally exit Desktop once if its debug interface is disabled.",
      ]);
    }
  }
  async rpc(method, params) {
    await this.connect();
    const client = this.client,
      epoch = this.epoch,
      adapterNamespace = this.clientNamespace || namespace;
    if (!client) throw cancelled();
    try {
      return await client.evaluate(
        createRendererCommandSource(
          method === "turn/start"
            ? "startTurn"
            : method === "turn/interrupt"
              ? "interruptTurn"
              : "rpc",
          method === "turn/start" || method === "turn/interrupt"
            ? params
            : { method, params },
          adapterNamespace,
        ),
        true,
        { timeoutMs: this.requestTimeoutMs, objectGroup: adapterNamespace },
      );
    } catch (e) {
      if (transportLost(e)) {
        if (this.client === client && this.epoch === epoch) {
          this.client = null;
          this.clientNamespace = null;
          this.clientGeneration = null;
          this.state = "error";
          this.error = e.message;
          this.emit("disconnect", {
            epoch,
            reason: "native-context-lost",
            error: e.message,
          });
        }
        client.close();
        if (
          [
            "turn/start",
            "turn/interrupt",
            "codex-web/local/server-requests/respond",
          ].includes(method)
        )
          throw Object.assign(
            new PhoneError(
              "native_outcome_unknown",
              e.message +
                " The native operation may already have started. Refresh its state; do not replay with a new request id.",
            ),
            { outcomeUnknown: true },
          );
      }
      throw e;
    }
  }
  async health() {
    try {
      const value = await this.rpc("thread/list", {
        limit: 1,
        archived: false,
        sortKey: "updated_at",
        modelProviders: [],
      });
      if (!Array.isArray(value?.data))
        throw Error("Invalid native thread/list response");
      return {
        ok: true,
        state: "ready",
        nativeThreadList: true,
        epoch: this.epoch,
      };
    } catch (e) {
      return {
        ok: false,
        state: this.state,
        code: "desktop_unavailable",
        message: e.message,
      };
    }
  }
  async close() {
    const oldEpoch = this.epoch;
    this.generation++;
    this.epoch = this.baseNamespace + ":" + this.generation;
    const pending = this.connecting;
    this.connecting = null;
    this.connectAbort?.abort(cancelled());
    this.connectAbort = null;
    const c = this.client,
      adapterNamespace = this.clientNamespace,
      clientGeneration = this.clientGeneration;
    this.client = null;
    this.clientNamespace = null;
    this.clientGeneration = null;
    this.state = "disconnected";
    this.error = null;
    const disposals = [];
    const disposeClient = async (client, adapterNamespace, generation) => {
      const dispose = (async () => {
        try {
          await client.evaluate(
            createRendererDisposeSource(adapterNamespace, {
              familyNamespace: this.baseNamespace,
              generation,
            }),
            true,
            { timeoutMs: this.closeTimeoutMs },
          );
        } finally {
          client.close();
        }
      })();
      await settleWithin(dispose, this.closeTimeoutMs);
      client.close();
    };
    for (const [generation, client] of this.pendingClients) {
      this.pendingClients.delete(generation);
      disposals.push(
        disposeClient(
          client,
          this.baseNamespace + "_generation_" + generation,
          generation,
        ),
      );
    }
    this.emit("disconnect", { epoch: oldEpoch, reason: "closed" });
    if (c)
      disposals.push(
        disposeClient(c, adapterNamespace || namespace, clientGeneration || 0),
      );
    if (pending) disposals.push(settleWithin(pending, this.closeTimeoutMs));
    await Promise.all(disposals);
  }
}

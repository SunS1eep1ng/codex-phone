import WebSocket from "ws";
import { EventEmitter } from "node:events";
import {
  CODEX_DESKTOP_ADAPTER_GLOBAL as namespace,
  createRendererBootstrapSource,
  createRendererCommandSource,
  createRendererDisposeSource,
} from "./renderer-bootstrap.ts";
import { PhoneError } from "./state.mjs";
export class CDP extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.pending = new Map();
    this.id = 0;
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
        m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
      } else this.emit("event", m);
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error("CDP_DISCONNECTED"));
      }
      this.pending.clear();
      this.emit("disconnect");
    });
  }
  static async open(url) {
    const ws = new WebSocket(url, {
      maxPayload: 256 * 1024 * 1024,
      handshakeTimeout: 8000,
    });
    await new Promise((yes, no) => {
      ws.once("open", yes);
      ws.once("error", no);
    });
    return new CDP(ws);
  }
  call(method, params = {}, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("CDP_TIMEOUT: " + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, byValue = true) {
    const r = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: byValue,
      objectGroup: namespace,
    });
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.exception?.description || r.exceptionDetails.text,
      );
    return byValue ? r.result?.value : r.result;
  }
  close() {
    this.ws.close();
  }
}
export class NativeDriver extends EventEmitter {
  constructor({ port, verify = async () => {} }) {
    super();
    this.port = port;
    this.verify = verify;
    this.client = null;
    this.connecting = null;
    this.state = "disconnected";
    this.error = null;
  }
  async connect() {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
  async open() {
    let c;
    try {
      await this.verify(this.port);
      const r = await fetch(`http://127.0.0.1:${this.port}/json/list`, {
        signal: AbortSignal.timeout(5000),
      });
      const targets = await r.json();
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
      c = await CDP.open(ws.href);
      await c.call("Runtime.enable");
      const binding = namespace + "_event";
      await c.call("Runtime.addBinding", { name: binding });
      const prototype = await c.evaluate(
        `(async()=>{const required=['getHostId','getConversation','sendRequest','addApprovalRequestListener','addNotificationCallback','addTurnCompletedListener','addStreamRoleStateCallback'];let url;for(const script of document.querySelectorAll('script[src]')){const source=await(await fetch(script.src)).text();const match=source.match(/app-initial-[a-z0-9]+\\.js/);if(match){url=new URL(match[0],script.src).href;break;}}if(!url)throw Error('UNSUPPORTED_DESKTOP_MODULE');const module=await import(url);const type=Object.values(module).find(v=>typeof v==='function'&&v.prototype&&required.every(k=>typeof v.prototype[k]==='function'));if(!type)throw Error('UNSUPPORTED_DESKTOP_MANAGER');return type.prototype;})()`,
        false,
      );
      if (!prototype?.objectId) throw Error("UNSUPPORTED_DESKTOP_MANAGER");
      const objects = await c.call("Runtime.queryObjects", {
        prototypeObjectId: prototype.objectId,
        objectGroup: namespace,
      });
      await c.call("Runtime.callFunctionOn", {
        objectId: objects.objects.objectId,
        functionDeclaration: `function(){const manager=this.find(v=>!v.disposed&&v.getHostId()==='local');if(!manager)throw Error('NATIVE_MANAGER_MISSING');globalThis[${JSON.stringify(namespace + "_manager")}]=manager;return true;}`,
        returnByValue: true,
      });
      c.on("event", (m) => {
        if (m.method === "Runtime.bindingCalled" && m.params.name === binding) {
          try {
            this.emit("event", JSON.parse(m.params.payload));
          } catch {}
        }
      });
      const hello = await c.evaluate(createRendererBootstrapSource(binding));
      if (hello?.protocol !== 1 || hello.hostId !== "local")
        throw Error("NATIVE_CAPABILITY_MISMATCH");
      await c.call("Runtime.releaseObjectGroup", { objectGroup: namespace });
      this.client = c;
      this.state = "ready";
      this.error = null;
      c.on("disconnect", () => {
        if (this.client === c) {
          this.client = null;
          this.state = "disconnected";
        }
      });
    } catch (e) {
      c?.close();
      this.state = "error";
      this.error = e.message;
      throw new PhoneError("desktop_unavailable", e.message, [
        "Run doctor; normally exit Desktop once if its debug interface is disabled.",
      ]);
    }
  }
  async rpc(method, params) {
    await this.connect();
    try {
      return await this.client.evaluate(
        createRendererCommandSource(
          method === "turn/start"
            ? "startTurn"
            : method === "turn/interrupt"
              ? "interruptTurn"
              : "rpc",
          method === "turn/start" || method === "turn/interrupt"
            ? params
            : { method, params },
        ),
      );
    } catch (e) {
      const client = this.client;
      this.client = null;
      this.state = "error";
      this.error = e.message;
      client?.close();
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
      return { ok: true, state: "ready", nativeThreadList: true };
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
    const c = this.client;
    this.client = null;
    if (c) {
      await c.evaluate(createRendererDisposeSource()).catch(() => {});
      await c
        .evaluate(
          `delete globalThis[${JSON.stringify(namespace + "_manager")}]`,
        )
        .catch(() => {});
      c.close();
    }
  }
}

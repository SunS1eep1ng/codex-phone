import http from "node:http";
import { equal } from "./auth.mjs";
const allowedAPI = new Set([
  "rpc",
  "events",
  "desktop-bridge/status",
  "server-requests/pending",
  "server-requests/respond",
  "meta/methods",
  "meta/notifications",
  "thread-turn-page",
  "thread-live-state",
  "thread-stream-events",
  "thread-file-change-fallback",
  "workspace-roots-state",
  "home-directory",
  "project-root-suggestion",
  "worktree/branches",
  "git/branches",
  "thread-titles",
  "thread-pins",
  "preferences/first-launch-plugins-card",
  "thread-automations",
  "project-automations",
  "prompts",
]);
export const json = (res, status, value) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
};
export async function bodyJSON(req, limit = 16384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(Error("request_too_large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
export function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}
export function createGateway({
  config,
  auth,
  upstream,
  health,
  apkPath,
  nativeRPC,
}) {
  const virtual = http.createServer();
  upstream.attachWebSocket(virtual);
  const sockets = new Map();
  const reject = (socket) => {
    socket.end(
      "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      res.setHeader("Cache-Control", "no-store");
      if (path === "/phone-api/info" && req.method === "GET")
        return json(res, 200, {
          deviceId: config.deviceId,
          deviceName: config.deviceName,
        });
      if (path === "/phone-api/app.apk" && req.method === "GET" && apkPath) {
        const { createReadStream } = await import("node:fs");
        const stream = createReadStream(apkPath);
        stream.on("error", () => {
          if (!res.headersSent) json(res, 404, { error: "apk_not_installed" });
          else res.destroy();
        });
        res.setHeader(
          "Content-Type",
          "application/vnd.android.package-archive",
        );
        stream.pipe(res);
        return;
      }
      const origin = req.headers.origin;
      if (origin && origin !== config.relay.endpoint)
        return json(res, 403, { error: "origin_not_allowed" });
      if (
        ["/phone-api/pair", "/phone-api/session", "/phone-api/unpair"].includes(
          path,
        ) &&
        req.method === "POST"
      ) {
        const body = await bodyJSON(req);
        if (path.endsWith("/unpair")) {
          const p = auth.validate(body);
          await auth.revoke(p.phoneId);
          return json(res, 200, { ok: true });
        }
        const result = await (path.endsWith("/pair")
          ? auth.pair(body)
          : auth.session(body));
        const { token, ...safe } = result;
        res.setHeader(
          "Set-Cookie",
          `bridge_phone_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000))}`,
        );
        return json(res, 200, safe);
      }
      if (!auth.authorized(req))
        return json(res, 401, { error: "phone_not_authorized" });
      if (path === "/phone-api/health") return json(res, 200, await health());
      if (path === "/codex-api/meta/methods")
        return json(res, 200, {
          data: [
            "thread/list",
            "thread/read",
            "thread/resume",
            "thread/start",
            "thread/archive",
            "thread/name/set",
            "turn/start",
            "turn/interrupt",
            "model/list",
            "account/read",
            "account/rateLimits/read",
            "config/read",
            "skills/list",
          ],
        });
      if (path === "/codex-api/meta/notifications")
        return json(res, 200, {
          data: [
            "turn/started",
            "turn/completed",
            "item/started",
            "item/completed",
            "item/agentMessage/delta",
            "server/request",
            "server/request/resolved",
          ],
        });
      if (nativeRPC && path === "/codex-api/desktop-bridge/status")
        return json(res, 200, {
          ...(await health()),
          enabled: true,
          mode: "agent",
          devices: [
            {
              deviceId: config.deviceId,
              deviceName: config.deviceName,
              connected: true,
            },
          ],
        });
      // These upstream auxiliary routes otherwise read through its standalone AppServer.
      // Serve them from the same native manager, without spawning a second conversation.
      if (
        nativeRPC &&
        [
          "/codex-api/thread-live-state",
          "/codex-api/thread-turn-page",
          "/codex-api/thread-file-change-fallback",
          "/codex-api/thread-stream-events",
        ].includes(path)
      ) {
        const threadId = url.searchParams.get("threadId");
        if (!threadId) return json(res, 400, { error: "thread_id_required" });
        if (path.endsWith("/thread-stream-events"))
          return json(res, 200, { events: [] });
        if (path.endsWith("/thread-file-change-fallback"))
          return json(res, 200, { items: [] });
        const result = await nativeRPC("thread/read", {
          threadId,
          includeTurns: true,
          codexPhoneFullHistory: true,
        });
        const turns = result?.thread?.turns || [];
        if (path.endsWith("/thread-live-state"))
          return json(res, 200, {
            threadId,
            conversationState: { turns },
            ownerClientId: null,
            liveStateError: null,
            isInProgress: turns.at(-1)?.status === "inProgress",
          });
        const before = url.searchParams.get("beforeTurnId");
        const limit = Math.max(
          1,
          Math.min(50, Number(url.searchParams.get("limit")) || 10),
        );
        const index = before
          ? turns.findIndex((t) => t.id === before)
          : turns.length;
        const end = Math.max(0, index);
        const start = Math.max(0, end - limit);
        return json(res, 200, {
          result: {
            ...result,
            thread: { ...result.thread, turns: turns.slice(start, end) },
          },
          startTurnIndex: start,
          hasMoreOlder: start > 0,
        });
      }
      // Public Agent/admin access is forbidden even after phone authentication.
      if (
        path.startsWith("/_") ||
        path.startsWith("/phone-api/") ||
        path === "/codex-api/agent/ws"
      )
        return json(res, 404, { error: "not_found" });
      if (path.startsWith("/codex-api/") && !allowedAPI.has(path.slice(11)))
        return json(res, 403, {
          error: "feature_not_available",
          message:
            "This feature is outside the native Desktop companion scope.",
        });
      // Only upstream static assets, native RPC and explicitly allowed local preferences.
      if (
        !path.startsWith("/codex-api/") &&
        !["GET", "HEAD"].includes(req.method)
      )
        return json(res, 405, { error: "method_not_allowed" });
      upstream.app(req, res);
    } catch (e) {
      if (!res.headersSent)
        json(res, e.status || 400, {
          error: e.code || e.message || "invalid_request",
        });
      else res.destroy();
    }
  });
  const onRevoke = (id) => {
    for (const [socket, phoneId] of sockets)
      if (phoneId === id) socket.destroy();
  };
  auth.listeners.add(onRevoke);
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const phone = auth.authorized(req);
    if (
      !phone ||
      path !== "/codex-api/ws" ||
      (req.headers.origin && req.headers.origin !== config.relay.endpoint)
    )
      return reject(socket);
    sockets.set(socket, phone.phoneId);
    const expiry = setInterval(() => {
      if (!auth.authorized(req)) socket.destroy();
    }, 30000);
    expiry.unref();
    socket.once("close", () => {
      clearInterval(expiry);
      sockets.delete(socket);
    });
    virtual.emit("upgrade", req, socket, head);
  });
  server.on("close", () => auth.listeners.delete(onRevoke));
  return {
    server,
    virtual,
    close() {
      for (const socket of sockets.keys()) socket.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}
export function createControl({ config, upstream, actions }) {
  const virtual = http.createServer();
  upstream.attachWebSocket(virtual);
  const server = http.createServer(async (req, res) => {
    if (!equal(req.headers.authorization, "Bearer " + config.adminSecret))
      return json(res, 401, { error: "local_administrator_required" });
    try {
      const name = new URL(req.url, "http://localhost").pathname.slice(1);
      if (
        !["status", "doctor", "pair", "phones", "revoke", "stop"].includes(name)
      )
        return json(res, 404, { error: "not_found" });
      if (
        !["status", "doctor", "phones"].includes(name) &&
        req.method !== "POST"
      )
        return json(res, 405, { error: "method_not_allowed" });
      json(
        res,
        200,
        await actions(name, req.method === "POST" ? await bodyJSON(req) : {}),
      );
    } catch (e) {
      json(res, 400, { error: e.code || e.message });
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/codex-api/agent/ws" ||
      !equal(req.headers.authorization, "Bearer " + config.agentSecret)
    ) {
      socket.destroy();
      return;
    }
    virtual.emit("upgrade", req, socket, head);
  });
  return server;
}

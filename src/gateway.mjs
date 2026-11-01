import http from "node:http";
import { equal } from "./auth.mjs";
import { verifyControlRequest, controlResponse } from "./control-auth.mjs";
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
export async function bodyText(req, limit = 16384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(Error("request_too_large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}
export async function bodyJSON(req, limit = 16384) {
  return JSON.parse((await bodyText(req, limit)) || "{}");
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
  recovery,
  acknowledgeOperation,
  staticAssets = {},
  authCheckIntervalMs = 1000,
}) {
  const virtual = http.createServer();
  upstream.attachWebSocket(virtual);
  const sockets = new Map();
  const streams = new Map();
  const pageEpochs = new Map();
  const validPage = (value) =>
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(value)
      ? value
      : null;
  const pageEpoch = (phoneId, pageId, bump = false) => {
    if (!pageId) return null;
    const key = phoneId + ":" + pageId;
    const value = (pageEpochs.get(key) || 0) + (bump ? 1 : 0);
    pageEpochs.delete(key);
    pageEpochs.set(key, value);
    while (pageEpochs.size > 1024)
      pageEpochs.delete(pageEpochs.keys().next().value);
    return value;
  };
  const checkAuthorizations = () => {
    for (const [socket, entry] of sockets)
      if (!auth.authorized(entry.req)) socket.destroy();
    for (const [response, entry] of streams)
      if (!auth.authorized(entry.req)) response.destroy();
  };
  const authorizationTimer = setInterval(
    checkAuthorizations,
    authCheckIntervalMs,
  );
  authorizationTimer.unref();
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
      const asset = staticAssets[path];
      if (asset && ["GET", "HEAD"].includes(req.method)) {
        const { createReadStream } = await import("node:fs");
        res.setHeader(
          "Content-Type",
          asset.type || "text/javascript; charset=utf-8",
        );
        res.setHeader("Cache-Control", asset.cacheControl || "no-cache");
        if (asset.cacheable) res.setHeader("X-Codex-Phone-Static", "1");
        if (path === "/sw.js") res.setHeader("Service-Worker-Allowed", "/");
        const stream = createReadStream(asset.path);
        stream.once("error", () => {
          if (!res.headersSent)
            json(res, 503, { error: "client_assets_missing" });
          else res.destroy();
        });
        if (req.method === "HEAD") {
          stream.destroy();
          res.end();
        } else stream.pipe(res);
        return;
      }
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
      const phone = auth.authorized(req);
      if (!phone) return json(res, 401, { error: "phone_not_authorized" });
      streams.set(res, { req, phoneId: phone.phoneId });
      const release = () => streams.delete(res);
      res.once("finish", release);
      res.once("close", release);
      if (path === "/phone-api/health") return json(res, 200, await health());
      if (path === "/phone-api/recovery" && req.method === "GET") {
        if (!recovery)
          return json(res, 503, { ok: false, error: "recovery_unavailable" });
        const result = await recovery(
          url.searchParams.get("threadId") || null,
          { probe: url.searchParams.get("probe") === "1" },
        );
        const pageId = validPage(url.searchParams.get("pageId"));
        const sequence = pageEpoch(phone.phoneId, pageId);
        return json(res, result.ok ? 200 : 503, {
          ...result,
          ...(pageId ? { epoch: `${result.epoch}:page:${sequence}` } : {}),
        });
      }
      if (path === "/phone-api/recovery/ack" && req.method === "POST") {
        if (!acknowledgeOperation)
          return json(res, 503, { error: "recovery_unavailable" });
        const body = await bodyJSON(req);
        return json(res, 200, await acknowledgeOperation(body.operationId));
      }
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
      if (nativeRPC && path === "/codex-api/desktop-bridge/status") {
        const status = await health();
        return json(res, 200, {
          ...status,
          state: status.state || (status.ok ? "ready" : "disconnected"),
          enabled: true,
          mode: "agent",
          devices: [
            {
              deviceId: config.deviceId,
              deviceName: config.deviceName,
              connected: status.ok === true,
            },
          ],
        });
      }
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
          return json(res, 200, { data: [] });
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
    for (const [socket, entry] of sockets)
      if (entry.phoneId === id) socket.destroy();
    for (const [response, entry] of streams)
      if (entry.phoneId === id) response.destroy();
  };
  auth.listeners.add(onRevoke);
  server.on("upgrade", (req, socket, head) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      const phone = auth.authorized(req);
      if (
        !phone ||
        path !== "/codex-api/ws" ||
        (req.headers.origin && req.headers.origin !== config.relay.endpoint)
      )
        return reject(socket);
      sockets.set(socket, { phoneId: phone.phoneId, req });
      const pageId = validPage(
        /(?:^|;\s*)codex_phone_page=([^;]+)/.exec(
          req.headers.cookie || "",
        )?.[1],
      );
      pageEpoch(phone.phoneId, pageId);
      socket.once("close", () => {
        sockets.delete(socket);
        pageEpoch(phone.phoneId, pageId, true);
      });
      virtual.emit("upgrade", req, socket, head);
    } catch {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    }
  });
  server.on("close", () => {
    auth.listeners.delete(onRevoke);
    clearInterval(authorizationTimer);
  });
  return {
    server,
    virtual,
    close() {
      clearInterval(authorizationTimer);
      auth.listeners.delete(onRevoke);
      for (const socket of sockets.keys()) socket.destroy();
      for (const response of streams.keys()) response.destroy();
      server.closeAllConnections();
      return server.listening
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve();
    },
  };
}
export function createControl({ config, upstream, actions }) {
  const virtual = http.createServer();
  upstream.attachWebSocket(virtual);
  const seen = new Map();
  const upgrades = new Set();
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      const response = controlResponse(
        config,
        req.headers["x-codex-control-nonce"],
        status,
        value,
      );
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...response.headers,
      });
      res.end(response.text);
    };
    try {
      const text = await bodyText(req);
      if (!verifyControlRequest(config, req, text, seen))
        return reply(401, { error: "local_administrator_required" });
      const name = new URL(req.url, "http://localhost").pathname.slice(1);
      if (
        !["status", "doctor", "pair", "phones", "revoke", "stop"].includes(name)
      )
        return reply(404, { error: "not_found" });
      if (
        !["status", "doctor", "phones"].includes(name) &&
        req.method !== "POST"
      )
        return reply(405, { error: "method_not_allowed" });
      reply(
        200,
        await actions(
          name,
          req.method === "POST" ? JSON.parse(text || "{}") : {},
        ),
      );
    } catch (e) {
      if (!res.headersSent) reply(400, { error: e.code || e.message });
      else res.destroy();
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
    upgrades.add(socket);
    socket.once("close", () => upgrades.delete(socket));
    virtual.emit("upgrade", req, socket, head);
  });
  server.closeOwnedSockets = () => {
    for (const socket of upgrades) socket.destroy();
  };
  return server;
}

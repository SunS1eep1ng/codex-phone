// Adapter for the Desktop-owned manager service. Only already-loaded application
// modules are considered; this never constructs a manager or another harness.
export async function discoverServiceModules(client) {
  const urls = new Set();
  const receive = (event) => {
    if (
      event.method === "Debugger.scriptParsed" &&
      /^app:\/\/-\/assets\/app-shared-[a-z0-9_-]+\.js$/i.test(
        event.params?.url || "",
      )
    )
      urls.add(event.params.url);
  };
  const remove = client.onEvent
    ? client.onEvent(receive)
    : (client.on("event", receive), () => client.off("event", receive));
  try {
    await client.call("Debugger.enable");
    return [...urls].slice(0, 8);
  } finally {
    remove();
    await client.call("Debugger.disable").catch(() => {});
  }
}

// This function is also serialized into the renderer. Keep all browser-side
// helpers inside it and make the module loader injectable for isolated tests.
export async function installServiceManager(
  { moduleUrls, managerKey, timeoutMs = 8000, familyNamespace, generation = 0 },
  loadModule = (url) => import(url),
) {
  let service;
  for (const url of moduleUrls) {
    if (!/^app:\/\/-\/assets\/app-shared-[a-z0-9_-]+\.js$/i.test(url)) continue;
    const module = await loadModule(url);
    for (const value of Object.values(module)) {
      if (!value || typeof value !== "object") continue;
      const candidate = value.appServerManagers;
      if (candidate && typeof candidate.dup === "function") {
        service = candidate.dup();
        break;
      }
    }
    if (service) break;
  }
  if (!service) return { kind: "unavailable" };

  const subscriptions = new Set();
  const conversations = new Map();
  const notifications = new Set();
  const approvalListeners = new Set();
  const stateListeners = new Set();
  const waiting = new Set();
  let remote,
    disposed = false,
    failure,
    readyTimer,
    recentTimer;
  const release = (value) => {
    try {
      value?.[Symbol.dispose]?.();
    } catch {}
  };
  const check = () => {
    if (disposed)
      throw Error(
        "Compatible native Desktop manager required: " +
          (failure || "service closed"),
      );
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(readyTimer);
    clearTimeout(recentTimer);
    for (const reject of waiting)
      reject(Error("Desktop manager service closed"));
    waiting.clear();
    for (const slot of [...subscriptions]) slot.stop();
    release(remote);
    release(service);
    conversations.clear();
    notifications.clear();
    approvalListeners.clear();
    stateListeners.clear();
  };
  const broken = (error) => {
    failure = error?.message || "Desktop manager service disconnected";
    dispose();
  };
  const track = (promise) => {
    const slot = {
      active: true,
      promise,
      lease: null,
      stop() {
        if (!slot.active) return;
        slot.active = false;
        subscriptions.delete(slot);
        release(slot.lease);
        release(promise);
      },
    };
    subscriptions.add(slot);
    promise.onRpcBroken?.(broken);
    const ready = Promise.resolve(promise).then(
      (lease) => {
        if (!slot.active || disposed) release(lease);
        else {
          slot.lease = lease;
          lease.onRpcBroken?.(broken);
        }
      },
      (error) => {
        if (slot.active) broken(error);
        throw error;
      },
    );
    // Some callers only need the disposer, but rejection must still be observed.
    ready.catch(() => {});
    return { stop: () => slot.stop(), ready };
  };
  const subscribe = (request) => {
    check();
    const listener = request.listener;
    return track(
      remote.subscribe({
        ...request,
        key: { hostId: "local", ...request.key },
        listener: (...args) => {
          if (!disposed) listener(...args);
        },
      }),
    );
  };
  const store = (id, value) => {
    if (disposed || !id || !value) return;
    conversations.set(id, value);
    for (const listener of stateListeners) listener(id, value);
  };
  const notify = (event) => {
    for (const entry of notifications)
      if (entry.methods.includes(event.method)) entry.listener(event);
  };

  try {
    const ready = new Promise((resolve, reject) => {
      waiting.add(reject);
      readyTimer = setTimeout(
        () => reject(Error("Desktop manager service timed out")),
        timeoutMs,
      );
      const subscription = track(
        service.subscribe("local", (state) => {
          if (disposed) return;
          if (state.status !== "ready") {
            if (remote)
              broken(Error("Desktop manager service is " + state.status));
            return;
          }
          if (remote) {
            broken(Error("Desktop manager service was replaced"));
            return;
          }
          remote = state.manager.dup();
          remote.onRpcBroken?.(broken);
          resolve();
        }),
      );
      subscription.ready.catch(reject);
    });
    await ready;
    waiting.clear();
    clearTimeout(readyTimer);
    check();

    // Desktop publishes its loaded conversations and pending requests here.
    // This compact snapshot also seeds approvals that predate our connection.
    const initial = new Promise((resolve, reject) => {
      waiting.add(reject);
      recentTimer = setTimeout(
        () => reject(Error("Desktop recent conversation snapshot timed out")),
        timeoutMs,
      );
      const subscription = subscribe({
        type: "host",
        field: "recentThreads",
        listener: (entries) => {
          if (!Array.isArray(entries)) return;
          const live = new Set();
          for (const value of entries) {
            const id = value.summary?.conversationId;
            if (typeof id !== "string") continue;
            live.add(id);
            store(id, { ...value, id });
          }
          for (const id of conversations.keys())
            if (!live.has(id)) conversations.delete(id);
          resolve();
        },
      });
      subscription.ready.catch(reject);
    });
    await initial;
    waiting.clear();
    clearTimeout(recentTimer);
    check();

    const approvals = subscribe({
      type: "event",
      event: "approval-request",
      listener: async (event) => {
        try {
          const value = await remote.getConversation(event.conversationId);
          store(event.conversationId, value);
          if (!disposed)
            for (const listener of approvalListeners) listener(event);
        } catch (error) {
          broken(error);
        }
      },
    });
    const resolved = subscribe({
      type: "event",
      event: "approval-resolved",
      listener: (event) => {
        const id = event.requestId ?? event.id;
        for (const value of conversations.values())
          if (Array.isArray(value.requests))
            value.requests = value.requests.filter(
              (request) => request.id !== id,
            );
        notify({ method: "serverRequest/resolved", params: { requestId: id } });
      },
    });
    await Promise.all([approvals.ready, resolved.ready]);
    check();

    const reply = async (pending, message) => {
      check();
      const id = pending.id,
        threadId = pending.conversationId;
      if (
        !Number.isSafeInteger(id) ||
        !threadId ||
        message.requestId !== id ||
        message.conversationId !== threadId
      )
        throw Error("Desktop approval identity mismatch");
      const methods = {
        "item/commandExecution/requestApproval": [
          "replyWithCommandExecutionApprovalDecision",
          message.decision,
        ],
        "item/fileChange/requestApproval": [
          "replyWithFileChangeApprovalDecision",
          message.decision,
        ],
        "item/permissions/requestApproval": [
          "replyWithPermissionsRequestApprovalResponse",
          message.response,
        ],
      };
      const entry = methods[pending.method];
      if (!entry || entry[1] == null)
        throw Error("Unsupported Desktop approval response");
      await remote[entry[0]](threadId, id, entry[1]);
      const value = conversations.get(threadId);
      if (value && Array.isArray(value.requests))
        value.requests = value.requests.filter((request) => request.id !== id);
    };
    const facade = {
      __codexPhoneOwned: true,
      get disposed() {
        return disposed;
      },
      getHostId: () => "local",
      getConversation: (id) => conversations.get(id) ?? null,
      getRecentConversations: () =>
        [...conversations.keys()].map((id) => ({ id })),
      isConversationStreaming: (id) =>
        conversations.get(id)?.isResponseInProgress ?? false,
      async sendRequest(method, params, options) {
        check();
        return remote.sendRequest(method, params, options);
      },
      addApprovalRequestListener(listener) {
        approvalListeners.add(listener);
        return () => approvalListeners.delete(listener);
      },
      addNotificationCallback(methods, listener) {
        const entry = { methods, listener };
        notifications.add(entry);
        const subscription = subscribe({
          type: "notification",
          methods,
          listener,
        });
        return () => {
          notifications.delete(entry);
          subscription.stop();
        };
      },
      addTurnCompletedListener(listener) {
        return subscribe({
          type: "event",
          event: "turn-completed",
          listener: (value) => listener(value.event ?? value),
        }).stop;
      },
      addStreamRoleStateCallback(listener) {
        return subscribe({
          type: "event",
          event: "stream-role-changed",
          listener: (event) =>
            listener(event.conversationId, { role: event.role }),
        }).stop;
      },
      addConversationStateCallback(listener) {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      replyToServerRequest: reply,
      // Used by the legacy companion integration; look up a known request rather
      // than accepting a caller-provided method or thread identity.
      async respondToRequest(params) {
        const matches = [];
        for (const [conversationId, value] of conversations)
          for (const request of value.requests || [])
            if (request.id === params.id)
              matches.push({ ...request, conversationId });
        if (matches.length !== 1)
          throw Error("No unique pending Desktop approval found");
        const pending = matches[0];
        const decision = params.error ? "decline" : params.result?.decision;
        const response = params.error
          ? { permissions: {}, scope: "turn" }
          : params.result;
        if (
          pending.method !== "item/permissions/requestApproval" &&
          (typeof decision !== "string" || !decision)
        )
          throw Error("Desktop approval decision required");
        await reply(pending, {
          requestId: pending.id,
          conversationId: pending.conversationId,
          decision,
          response,
        });
        return {};
      },
      dispose,
    };
    const old = globalThis[managerKey];
    const namespace = managerKey.endsWith("_manager")
      ? managerKey.slice(0, -8)
      : managerKey;
    if (
      generation > 0 &&
      (globalThis[namespace + "_cancelled"] ||
        globalThis[familyNamespace + "_lifecycle"]?.generation > generation)
    )
      throw Error("Native adapter lifecycle was cancelled");
    if (old?.__codexPhoneOwned) old.dispose();
    globalThis[managerKey] = facade;
    return { kind: "desktop-service-rpc", hostId: "local" };
  } catch (error) {
    dispose();
    throw error;
  }
}

export const createServiceManagerSource = (options) =>
  `(${installServiceManager.toString()})(${JSON.stringify(options)})`;

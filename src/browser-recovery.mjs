// A small companion to the pinned UI. It never sends or replays a write RPC.
export function createPageIdentity(window, document) {
  const crypto = window.crypto;
  const pageId =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
  // This cookie is only an event-stream correlation label, never authentication.
  // Set it before the upstream UI opens its WebSocket. Each new document gets a new ID.
  // Same-origin tabs share cookies; full multi-tab isolation needs explicit WS page IDs.
  document.cookie = `codex_phone_page=${pageId}; Path=/; SameSite=Strict${window.location.protocol === "https:" ? "; Secure" : ""}`;
  return pageId;
}

export async function acknowledgeUncertainOperations(
  operations,
  sendAcknowledgement,
) {
  const acknowledged = new Set();
  for (const operation of operations || []) {
    if (
      operation?.state !== "uncertain" ||
      typeof operation.id !== "string" ||
      !operation.id ||
      acknowledged.has(operation.id)
    )
      continue;
    // Explicit user acknowledgement records only a review, not native success.
    await sendAcknowledgement({ operationId: operation.id });
    acknowledged.add(operation.id);
  }
  return acknowledged.size;
}

export function parseThreadId(hash = "") {
  const path = String(hash).replace(/^#/, "").split("?")[0];
  const parts = path.split("/").filter(Boolean);
  const value =
    parts.length === 4 && parts[0] === "device" && parts[2] === "thread"
      ? parts[3]
      : parts.length === 2 && parts[0] === "thread"
        ? parts[1]
        : "";
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

export function hasUnsentDraft(document) {
  if (
    [...document.querySelectorAll("textarea")].some(
      (node) => String(node.value || "").length,
    )
  )
    return true;
  if (
    [
      ...document.querySelectorAll(
        '[contenteditable]:not([contenteditable="false"])',
      ),
    ].some((node) => String(node.textContent || "").trim())
  )
    return true;
  return [...document.querySelectorAll('input[type="file"]')].some(
    (node) => node.files?.length,
  );
}

function nativeReady(snapshot) {
  const connection = snapshot?.connection;
  if (!snapshot?.ok || !snapshot.epoch) return false;
  if (snapshot.httpStatus != null && snapshot.httpStatus !== 200) return false;
  if (typeof connection === "string") return connection === "ready";
  return connection?.state === "ready" && connection.nativeReady !== false;
}

export function createRecoveryController({
  fetchSnapshot,
  getThreadId,
  hasDraft,
  reload,
  notify,
}) {
  let initialized = false,
    epoch = "",
    disconnected = false,
    outage = 0;
  let pending = null,
    stopped = false,
    inFlight = null,
    queued = false;
  let latest = null;
  const handled = new Set();

  function markDisconnected(reason = "network") {
    if (stopped) return;
    if (!disconnected) outage++;
    disconnected = true;
    notify({ kind: "waiting", reason, snapshot: latest });
  }
  function tryReload() {
    if (!pending || stopped) return false;
    if (hasDraft()) {
      notify({ kind: "draft", snapshot: pending.snapshot });
      return false;
    }
    if (handled.has(pending.key)) return false;
    const item = pending;
    pending = null;
    handled.add(item.key);
    // The page reload obtains real upstream stores/history/approvals at this hash.
    reload(item.snapshot);
    return true;
  }
  async function refresh() {
    if (stopped) return;
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    const requestedThread = getThreadId();
    inFlight = (async () => {
      let result;
      try {
        result = await fetchSnapshot(requestedThread, { probe: true });
      } catch (error) {
        markDisconnected("network");
        notify({ kind: "waiting", reason: "network", error, snapshot: latest });
        return;
      }
      if (stopped) return;
      if (requestedThread !== getThreadId()) {
        queued = true;
        return;
      }
      latest = result;
      if (result?.httpStatus === 401) {
        markDisconnected("authorization");
        notify({ kind: "authorization", snapshot: result });
        return;
      }
      if (!nativeReady(result)) {
        markDisconnected("desktop");
        return;
      }
      const changed = initialized && epoch !== String(result.epoch);
      const recovered = disconnected;
      if (changed || recovered) {
        const probeEpoch = String(result.epoch);
        try {
          result = await fetchSnapshot(requestedThread, { probe: false });
        } catch (error) {
          markDisconnected("network");
          notify({
            kind: "waiting",
            reason: "network",
            error,
            snapshot: latest,
          });
          return;
        }
        if (stopped) return;
        if (requestedThread !== getThreadId()) {
          queued = true;
          return;
        }
        latest = result;
        if (result?.httpStatus === 401) {
          markDisconnected("authorization");
          notify({ kind: "authorization", snapshot: result });
          return;
        }
        if (!nativeReady(result) || String(result.epoch) !== probeEpoch) {
          markDisconnected("desktop");
          return;
        }
      }
      initialized = true;
      epoch = String(result.epoch);
      disconnected = false;
      if (changed || recovered) {
        const key = `${epoch}\n${requestedThread}\n${outage}`;
        if (!handled.has(key)) pending = { key, snapshot: result };
      }
      if (pending) {
        pending.snapshot = {
          ...pending.snapshot,
          uncertainOperations: result.uncertainOperations || [],
        };
        tryReload();
      } else
        notify(
          result.uncertainOperations?.length
            ? { kind: "uncertain", snapshot: result }
            : null,
        );
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
      if (queued && !stopped) {
        queued = false;
        queueMicrotask(() => void refresh());
      }
    }
  }
  return {
    refresh,
    markDisconnected,
    tryReload,
    stop() {
      stopped = true;
      pending = null;
      queued = false;
    },
    get state() {
      return { initialized, epoch, disconnected, pending: !!pending };
    },
    get snapshot() {
      return latest;
    },
  };
}

export function installBrowserRecovery({
  window,
  document,
  pollIntervalMs = 15000,
  resumeAfterMs = 5000,
} = {}) {
  window ||= globalThis.window;
  document ||= window?.document;
  if (!window || !document) return null;
  if (window.codexPhoneRecovery) return window.codexPhoneRecovery;
  const pageId = createPageIdentity(window, document);
  const zh = String(window.navigator.language || "")
    .toLowerCase()
    .startsWith("zh");
  const text = (cn, en) => (zh ? cn : en);
  let banner = null,
    hiddenAt = 0,
    timer = null,
    controller,
    acknowledging = false,
    disposed = false;
  function notify(notice) {
    if (disposed) return;
    if (!notice) {
      banner?.remove();
      banner = null;
      return;
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "codex-phone-recovery-notice";
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");
      banner.style.cssText =
        "position:fixed;left:12px;right:12px;top:max(12px,env(safe-area-inset-top));z-index:2147483647;padding:12px 14px;border:1px solid #8b9bb5;border-radius:10px;background:#172132;color:#fff;font:14px/1.5 system-ui;box-shadow:0 3px 18px #0005;overflow-wrap:anywhere";
      (document.body || document.documentElement).append(banner);
    }
    const count = notice.snapshot?.uncertainOperations?.length || 0;
    const messages = {
      waiting: text(
        "电脑连接暂时中断，正在等待恢复。",
        "Computer connection interrupted. Waiting to recover.",
      ),
      authorization: text(
        "手机授权需要更新。请在应用菜单中重新连接；若授权已撤销，请重新配对。",
        "Phone authorization needs renewal. Reconnect from the app menu, or pair again if revoked.",
      ),
      draft: text(
        "连接已恢复，但检测到未发送的草稿或附件，已暂停刷新。请先发送、复制保存或清空草稿，再点“刷新会话”。",
        "Connection recovered. Refresh is paused to protect your unsent draft or attachment. Send, copy/save or clear it before refreshing.",
      ),
      uncertain: text(
        "有操作仍在等待结果或尚未确认，请先核对会话记录，避免重复发送。",
        "Some operation results are pending or unconfirmed. Check conversation history before sending again.",
      ),
      "ack-error": text(
        "暂未确认核对结果是否已保存。请重新检查，不要因此重复发送任务。",
        "The review acknowledgement could not be confirmed. Check again; do not resend the task because of this error.",
      ),
    };
    const message = document.createElement("span");
    message.textContent =
      (messages[notice.kind] || messages.waiting) +
      (count && notice.kind !== "uncertain"
        ? text(
            ` 另有 ${count} 项操作结果未确认，请先核对记录，勿重复发送。`,
            ` ${count} operation result(s) are unconfirmed; check history before sending again.`,
          )
        : "");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent =
      notice.kind === "draft"
        ? text("刷新会话", "Refresh conversation")
        : text("重新检查", "Check again");
    button.style.cssText =
      "margin-left:10px;padding:4px 9px;border:1px solid #b5c8e8;border-radius:5px;background:#eef4ff;color:#12213a;font:inherit;cursor:pointer";
    button.addEventListener("click", () => void controller.refresh());
    banner.replaceChildren(message, button);
    const uncertain = (notice.snapshot?.uncertainOperations || []).filter(
      (operation) => operation?.state === "uncertain",
    );
    if (uncertain.length) {
      const acknowledge = document.createElement("button");
      acknowledge.type = "button";
      acknowledge.setAttribute("data-codex-ack", "1");
      acknowledge.textContent = text(
        "已核对电脑记录",
        "I checked the computer history",
      );
      acknowledge.style.cssText = button.style.cssText;
      acknowledge.disabled = acknowledging;
      acknowledge.addEventListener("click", async () => {
        if (acknowledging) return;
        acknowledging = true;
        acknowledge.disabled = true;
        let failure = null;
        try {
          await acknowledgeUncertainOperations(uncertain, sendAcknowledgement);
        } catch (error) {
          failure = error;
        } finally {
          acknowledging = false;
          await controller.refresh();
          if (failure)
            notify({
              kind: "ack-error",
              snapshot: controller.snapshot || notice.snapshot,
            });
        }
      });
      banner.append(acknowledge);
    }
  }
  async function sendAcknowledgement(body) {
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 10000);
    try {
      const response = await window.fetch("/phone-api/recovery/ack", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true)
        throw new Error("acknowledgement_unconfirmed");
    } finally {
      window.clearTimeout(timeout);
    }
  }
  async function fetchSnapshot(threadId, { probe = false } = {}) {
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 10000);
    try {
      const params = new URLSearchParams();
      params.set("pageId", pageId);
      if (threadId) params.set("threadId", threadId);
      if (probe) params.set("probe", "1");
      const query = params.size ? "?" + params : "";
      const response = await window.fetch("/phone-api/recovery" + query, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: abort.signal,
      });
      const result = await response.json();
      return { ...result, httpStatus: response.status };
    } finally {
      window.clearTimeout(timeout);
    }
  }
  controller = createRecoveryController({
    fetchSnapshot,
    getThreadId: () => parseThreadId(window.location.hash),
    hasDraft: () => hasUnsentDraft(document),
    reload: () => window.location.reload(),
    notify,
  });
  const check = () => void controller.refresh();
  const resume = () => {
    controller.markDisconnected("resume");
    return controller.refresh();
  };
  const offline = () => controller.markDisconnected("offline");
  const online = () => {
    controller.markDisconnected("online");
    check();
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt >= resumeAfterMs)
      controller.markDisconnected("resume");
    hiddenAt = 0;
    check();
  };
  const pageshow = (event) => {
    if (event.persisted) controller.markDisconnected("resume");
    check();
  };
  window.addEventListener("offline", offline);
  window.addEventListener("online", online);
  window.addEventListener("pageshow", pageshow);
  window.addEventListener("hashchange", check);
  document.addEventListener("visibilitychange", visibility);
  timer = window.setInterval(
    () => {
      if (document.visibilityState !== "hidden") check();
    },
    Math.max(5000, pollIntervalMs),
  );
  const api = {
    pageId,
    check: () => controller.refresh(),
    resume,
    stop() {
      disposed = true;
      controller.stop();
      window.clearInterval(timer);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      window.removeEventListener("pageshow", pageshow);
      window.removeEventListener("hashchange", check);
      document.removeEventListener("visibilitychange", visibility);
      banner?.remove();
      banner = null;
      if (window.codexPhoneRecovery === api) delete window.codexPhoneRecovery;
    },
  };
  window.codexPhoneRecovery = api;
  check();
  return api;
}

if (typeof window !== "undefined" && window.document)
  installBrowserRecovery({ window });

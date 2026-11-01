// Own static cache only. Conversation/authentication HTML and APIs are network-only.
export const STATIC_CACHE = "codex-phone-static-v1";
const OWN_PREFIX = "codex-phone-static-";
const LEGACY_PREFIX = "codexweb-shell-";

export function isOwnedCache(name) {
  return name.startsWith(OWN_PREFIX) || name.startsWith(LEGACY_PREFIX);
}
export function isStaticPath(path) {
  return (
    path === "/phone-recovery.js" ||
    path === "/manifest.webmanifest" ||
    /^\/icons\/[A-Za-z0-9._-]+\.(png|svg|ico)$/.test(path) ||
    /^\/assets\/[A-Za-z0-9._-]+\.(js|css|woff2?|png|svg|ico)$/.test(path)
  );
}
export function shouldCache(request, response, origin) {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== origin ||
    !isStaticPath(url.pathname)
  )
    return false;
  if (
    response.status !== 200 ||
    response.redirected ||
    response.type === "opaque"
  )
    return false;
  // The gateway explicitly marks only public, secret-free static responses.
  if (response.headers.get("x-codex-phone-static") !== "1") return false;
  if (response.headers.has("set-cookie") || response.headers.has("set-cookie2"))
    return false;
  if (
    /\b(no-store|private)\b/i.test(response.headers.get("cache-control") || "")
  )
    return false;
  const type = response.headers.get("content-type") || "";
  if (/\.(js)$/.test(url.pathname))
    return /(?:javascript|ecmascript)/i.test(type);
  if (/\.css$/.test(url.pathname)) return /text\/css/i.test(type);
  if (url.pathname === "/manifest.webmanifest")
    return /(?:manifest\+json|application\/json)/i.test(type);
  return /^(image\/|font\/|application\/(?:font|vnd\.ms-fontobject))/i.test(
    type,
  );
}
export async function cleanOwnedCaches(caches) {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => isOwnedCache(name) && name !== STATIC_CACHE)
      .map((name) => caches.delete(name)),
  );
}
export function offlineDocument() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Phone · Connection unavailable</title><p>电脑暂时无法连接。恢复网络后重新打开或刷新。<br>Computer unavailable. Reopen or refresh after the connection recovers.</p>',
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
export async function handleWorkerFetch(request, { origin, fetch, caches }) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== origin) return fetch(request);
  const navigation =
    request.mode === "navigate" || request.destination === "document";
  if (navigation) {
    try {
      return await fetch(request);
    } catch {
      return offlineDocument();
    }
  }
  if (!isStaticPath(url.pathname)) return fetch(request);
  try {
    const response = await fetch(request);
    if (shouldCache(request, response, origin)) {
      try {
        await (await caches.open(STATIC_CACHE)).put(request, response.clone());
      } catch {
        /* Cache failure must not break online use. */
      }
    }
    return response;
  } catch (error) {
    const cached = await (await caches.open(STATIC_CACHE))
      .match(request)
      .catch(() => null);
    if (cached && shouldCache(request, cached, origin)) return cached;
    throw error;
  }
}

if (typeof self !== "undefined" && typeof self.skipWaiting === "function") {
  self.addEventListener("install", (event) =>
    event.waitUntil(self.skipWaiting()),
  );
  self.addEventListener("activate", (event) =>
    event.waitUntil(
      cleanOwnedCaches(caches)
        .catch(() => {})
        .then(() => self.clients.claim()),
    ),
  );
  self.addEventListener("fetch", (event) =>
    event.respondWith(
      handleWorkerFetch(event.request, {
        origin: self.location.origin,
        fetch: (request) => fetch(request),
        caches,
      }),
    ),
  );
}

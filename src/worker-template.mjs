const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
async function matchesSecret(actual, expected) {
  if (!actual || !expected) return false;
  const digest = async (text) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
  const a = await digest(actual),
    b = await digest(expected);
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a[index] ^ b[index];
  return difference === 0;
}
function validOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export async function handleRequest(request, env, upstreamFetch = fetch) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/_phone-local/"))
    return json({ error: "local_administrator_required" }, 403);
  if (url.pathname === "/_bridge/register") {
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405);
    if (!env.REGISTRATION_SECRET)
      return json({ error: "gateway_not_configured" }, 503);
    if (
      !(await matchesSecret(
        request.headers.get("authorization"),
        "Bearer " + env.REGISTRATION_SECRET,
      ))
    )
      return json({ error: "unauthorized" }, 401);
    const text = await request.text();
    if (text.length > 4096) return json({ error: "request_too_large" }, 413);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (data.deviceId !== env.DEVICE_ID || !validOrigin(data.origin))
      return json({ error: "invalid_device_or_origin" }, 400);
    const entry = {
      deviceId: env.DEVICE_ID,
      origin: new URL(data.origin).origin,
      updatedAt: Date.now(),
    };
    await env.DESKTOP_ENDPOINTS.put(env.DEVICE_ID, JSON.stringify(entry));
    return json({ ok: true, deviceId: env.DEVICE_ID });
  }
  if (url.pathname.startsWith("/_bridge/")) {
    if (url.pathname !== "/_bridge/health")
      return json({ error: "not_found" }, 404);
    return json({ service: "codex-phone-gateway", deviceId: env.DEVICE_ID });
  }
  const entry = await env.DESKTOP_ENDPOINTS.get(env.DEVICE_ID, {
    type: "json",
    cacheTtl: 60,
  });
  if (!entry || entry.deviceId !== env.DEVICE_ID || !validOrigin(entry.origin))
    return json(
      {
        error: "desktop_not_registered",
        message: "电脑尚未连接，请先打开电脑上的 ChatGPT。",
      },
      503,
    );
  const destination = new URL(url.pathname + url.search, entry.origin);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("authorization");
  headers.delete("x-codex-phone-internal");
  headers.delete("x-codex-admin-key");
  headers.set("x-codex-gateway-device", env.DEVICE_ID);
  let response;
  try {
    response = await upstreamFetch(
      new Request(destination, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : request.body,
        duplex: "half",
        redirect: "manual",
      }),
    );
  } catch {
    return json(
      {
        error: "desktop_unreachable",
        message: "暂时无法连接电脑，正在等待连接恢复。",
      },
      503,
    );
  }
  // WebSocket upgrades must retain the upstream response's webSocket handle.
  if (response.status === 101) return response;
  const outgoing = new Headers(response.headers);
  outgoing.set("cache-control", "no-store");
  outgoing.set("x-content-type-options", "nosniff");
  const location = outgoing.get("location");
  if (location) {
    try {
      const next = new URL(location, entry.origin);
      if (next.origin === entry.origin)
        outgoing.set(
          "location",
          url.origin + next.pathname + next.search + next.hash,
        );
    } catch {}
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outgoing,
  });
}
export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

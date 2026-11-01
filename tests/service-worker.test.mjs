import test from "node:test";
import assert from "node:assert/strict";
import {
  STATIC_CACHE,
  shouldCache,
  handleWorkerFetch,
  cleanOwnedCaches,
} from "../src/service-worker.mjs";
const origin = "https://synthetic.example";
const request = (path, extra = {}) => ({
  url: origin + path,
  method: "GET",
  mode: "cors",
  destination: "script",
  ...extra,
});
const script = (status = 200, extra = {}) =>
  new Response("/* public static fixture */", {
    status,
    headers: {
      "content-type": "text/javascript",
      "x-codex-phone-static": "1",
      "cache-control": "public, max-age=60",
      ...extra,
    },
  });
function cachesFixture() {
  const records = new Map(),
    writes = [];
  return {
    writes,
    records,
    open: async () => ({
      put: async (key, value) => {
        const url = typeof key === "string" ? key : key.url;
        writes.push(url);
        records.set(url, value);
      },
      match: async (key) =>
        records.get(typeof key === "string" ? key : key.url),
    }),
  };
}
test("service worker never caches authentication/API responses, errors, cookies or unmarked assets", () => {
  for (const path of [
    "/",
    "/phone-api/info",
    "/phone-api/recovery",
    "/phone-api/pair",
    "/phone-api/session",
    "/codex-api/rpc",
    "/pairing.html",
  ])
    assert.equal(shouldCache(request(path), script(), origin), false);
  for (const response of [
    script(401),
    script(503),
    script(200, { "set-cookie": "session=synthetic" }),
    script(200, { "cache-control": "no-store" }),
    script(200, { "cache-control": "private" }),
    script(200, { "x-codex-phone-static": "0" }),
    script(200, { "content-type": "application/json" }),
  ])
    assert.equal(
      shouldCache(request("/phone-recovery.js"), response, origin),
      false,
    );
  assert.equal(
    shouldCache(request("/phone-recovery.js"), script(), origin),
    true,
  );
});
test("a 401/503 navigation cannot overwrite the app shell or be served from a legacy cached error page", async () => {
  for (const status of [401, 503]) {
    const caches = cachesFixture();
    caches.records.set(
      "/",
      new Response("old unauthorized JSON", { status: 401 }),
    );
    const response = await handleWorkerFetch(
      request("/", { mode: "navigate", destination: "document" }),
      {
        origin,
        caches,
        fetch: async () => new Response("network error", { status }),
      },
    );
    assert.equal(response.status, status);
    assert.equal(caches.writes.length, 0);
    const offline = await handleWorkerFetch(
      request("/", { mode: "navigate", destination: "document" }),
      {
        origin,
        caches,
        fetch: async () => {
          throw Error("offline");
        },
      },
    );
    assert.equal(offline.status, 503);
    assert.match(await offline.text(), /Computer unavailable/);
    assert.equal(caches.writes.length, 0);
  }
});
test("only known owned cache prefixes are cleaned; unrelated same-origin cache is preserved", async () => {
  const removed = [];
  const caches = {
    keys: async () => [
      "codexweb-shell-v2",
      "codex-phone-static-v0",
      STATIC_CACHE,
      "unrelated-documents",
      "another-app-cache",
    ],
    delete: async (name) => removed.push(name),
  };
  await cleanOwnedCaches(caches);
  assert.deepEqual(removed.sort(), [
    "codex-phone-static-v0",
    "codexweb-shell-v2",
  ]);
});
test("verified public static scripts can fall back offline, while API traffic never uses a cache", async () => {
  const caches = cachesFixture();
  const req = request("/phone-recovery.js");
  assert.equal(
    (
      await handleWorkerFetch(req, {
        origin,
        caches,
        fetch: async () => script(),
      })
    ).status,
    200,
  );
  assert.equal(caches.writes.length, 1);
  const fallback = await handleWorkerFetch(req, {
    origin,
    caches,
    fetch: async () => {
      throw Error("offline");
    },
  });
  assert.equal(fallback.status, 200);
  await assert.rejects(
    handleWorkerFetch(request("/phone-api/recovery"), {
      origin,
      caches,
      fetch: async () => {
        throw Error("network unavailable");
      },
    }),
    /network unavailable/,
  );
  assert.equal(caches.writes.length, 1);
});
test("an online unauthorized static response remains unauthorized rather than hiding behind an old cached success", async () => {
  const caches = cachesFixture();
  const req = request("/phone-recovery.js");
  await handleWorkerFetch(req, { origin, caches, fetch: async () => script() });
  const response = await handleWorkerFetch(req, {
    origin,
    caches,
    fetch: async () => script(401),
  });
  assert.equal(response.status, 401);
  assert.equal(caches.writes.length, 1);
});

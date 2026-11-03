import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CloudflareRelay } from "../src/relay.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  const timers = new Set(),
    children = [];
  let log = "",
    registrations = 0;
  const dependencies = {
    platform: "win32",
    arch: "x64",
    stopTimeoutMs: 5,
    download: async () => "synthetic-cloudflared-never-executed",
    spawnProcess: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => {
        child.exitCode = 0;
        child.emit("exit", 0);
        return true;
      };
      children.push(child);
      return child;
    },
    readLog: async () => log,
    writeLog: async (_path, text) => {
      log = text;
    },
    setInterval: (callback) => {
      const timer = { callback, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearInterval: (timer) => timers.delete(timer),
    register: async () => {
      registrations++;
      return { ok: true };
    },
    probe: async () => ({ ok: true }),
    ...overrides,
  };
  const relay = new CloudflareRelay(
    {
      deviceId: "synthetic-pc",
      relay: {
        endpoint: "https://synthetic.invalid",
        registrationSecret: "synthetic",
      },
      ports: { gateway: 1 },
    },
    "synthetic-state-never-read",
    dependencies,
  );
  return {
    relay,
    timers,
    children,
    setLog: (value) => (log = value),
    get registrations() {
      return registrations;
    },
  };
}
test("external recovery cannot multiply the tunnel monitor; stop clears its only timer", async () => {
  const f = fixture();
  await f.relay.start();
  assert.equal(f.timers.size, 1);
  const firstTimer = f.relay.timer;
  f.children[0].emit("exit", 1);
  await f.relay.start();
  assert.equal(f.children.length, 2);
  assert.equal(f.timers.size, 1);
  assert.equal(f.relay.timer, firstTimer);
  await f.relay.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.relay.child, null);
  assert.equal(f.relay.origin, "");
});
test("stop aborts a pending download and late completion cannot spawn; later start still works", async () => {
  const gate = deferred();
  let downloads = 0,
    signal;
  const f = fixture({
    download: async (_asset, _path, options) => {
      downloads++;
      signal = options.signal;
      return downloads === 1 ? gate.promise : "synthetic-only";
    },
  });
  const starting = f.relay.start();
  await tick();
  await f.relay.stop();
  assert.equal(signal.aborted, true);
  gate.resolve("late-synthetic-only");
  await starting;
  assert.equal(f.children.length, 0);
  assert.equal(f.timers.size, 0);
  await f.relay.start();
  assert.equal(f.children.length, 1);
  assert.equal(f.timers.size, 1);
  await f.relay.stop();
});
test("late registration from a stopped generation cannot overwrite a new origin", async () => {
  const gate = deferred();
  let count = 0,
    oldSignal;
  const f = fixture({
    register: async (_url, options) => {
      count++;
      if (count === 1) {
        oldSignal = options.signal;
        return gate.promise;
      }
      return { ok: true };
    },
  });
  await f.relay.start();
  f.setLog("https://old-synthetic.trycloudflare.com");
  const oldTick = f.relay.tick();
  await tick();
  await f.relay.stop();
  assert.equal(oldSignal.aborted, true);
  await f.relay.start();
  f.setLog("https://new-synthetic.trycloudflare.com");
  await f.relay.tick();
  assert.equal(f.relay.origin, "https://new-synthetic.trycloudflare.com");
  gate.resolve({ ok: true });
  await oldTick;
  assert.equal(f.relay.origin, "https://new-synthetic.trycloudflare.com");
  await f.relay.stop();
  assert.equal((await f.relay.health()).ok, false);
});
test("empty logs are valid; registration failures retry once and stable origins do not rewrite KV", async () => {
  let count = 0;
  const f = fixture({
    register: async () =>
      ++count === 1 ? { ok: false, status: 503 } : { ok: true },
  });
  await f.relay.start();
  await f.relay.tick();
  assert.equal(count, 0);
  f.setLog("https://synthetic.trycloudflare.com");
  await assert.rejects(f.relay.tick(), /TUNNEL_REGISTRATION_FAILED: 503/);
  assert.equal(f.relay.origin, "");
  await f.relay.tick();
  await f.relay.tick();
  assert.equal(count, 2);
  assert.equal(f.relay.error, null);
  assert.equal((await f.relay.health()).ok, true);
  await f.relay.stop();
});
test("child error invalidates registration state and the existing monitor recovers", async () => {
  const f = fixture();
  await f.relay.start();
  f.setLog("https://synthetic.trycloudflare.com");
  await f.relay.tick();
  assert(f.relay.origin);
  f.children[0].emit("error", Error("synthetic spawn failure"));
  assert.equal(f.relay.child, null);
  assert.equal(f.relay.origin, "");
  const monitor = [...f.timers][0];
  monitor.callback();
  for (let i = 0; i < 10 && f.children.length < 2; i++) await tick();
  assert.equal(f.children.length, 2);
  assert.equal(f.timers.size, 1);
  await f.relay.stop();
});

test("a rejected live Quick Tunnel is retired and recreated with backoff and one monitor", async () => {
  let now = 0;
  const f = fixture({ now: () => now });
  await f.relay.start();
  f.setLog("https://synthetic.trycloudflare.com\nRegistered tunnel connection");
  await f.relay.tick();
  assert(f.relay.origin);
  f.setLog(
    "https://synthetic.trycloudflare.com\nRegistered tunnel connection\nUnauthorized: Tunnel not found",
  );
  await f.relay.tick();
  assert.equal(f.children[0].exitCode, 0);
  assert.equal(f.relay.child, null);
  assert.equal((await f.relay.health()).registered, false);
  await f.relay.start();
  assert.equal(f.children.length, 1);
  now = 8000;
  await f.relay.start();
  assert.equal(f.children.length, 2);
  assert.equal(f.timers.size, 1);
  assert.equal(f.relay.origin, "");
  await f.relay.stop();
});

test("a later registered connection supersedes an earlier tunnel rejection in the same log", async () => {
  const f = fixture();
  await f.relay.start();
  f.setLog(
    "https://synthetic.trycloudflare.com\nUnauthorized: Tunnel not found\nRegistered tunnel connection",
  );
  await f.relay.tick();
  assert.equal(f.relay.child, f.children[0]);
  assert(f.relay.origin);
  await f.relay.stop();
});

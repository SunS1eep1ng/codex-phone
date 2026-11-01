import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import {
  setupState,
  saveJSON,
  readJSON,
  assertPrivateStateDirectory,
  withFileLock,
} from "../src/state.mjs";

async function fixture(t) {
  const base = await fs.mkdtemp(join(tmpdir(), "codex-phone-state-"));
  assert(resolve(base).startsWith(resolve(tmpdir())));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const code = join(base, "code"),
    home = join(base, "home"),
    state = join(base, "private");
  await fs.mkdir(code);
  await fs.mkdir(home);
  return {
    base,
    code,
    home,
    state,
    options: {
      checkoutRoots: [code],
      homeDirectory: home,
      protectDirectory: async () => {
        await new Promise((done) => setTimeout(done, 10));
      },
    },
  };
}
test("concurrent first initialization shares one identity and preserves existing phone state", async (t) => {
  const f = await fixture(t);
  const configs = await Promise.all(
    Array.from({ length: 6 }, () => setupState(f.state, f.options)),
  );
  assert.equal(new Set(configs.map((c) => c.deviceId)).size, 1);
  assert.equal(new Set(configs.map((c) => c.adminSecret)).size, 1);
  await saveJSON(join(f.state, "phones.json"), {
    phones: [{ phoneId: "fixture-phone" }],
  });
  assert.equal(
    (await setupState(f.state, f.options)).deviceId,
    configs[0].deviceId,
  );
  assert.equal(
    (await readJSON(join(f.state, "phones.json"))).phones[0].phoneId,
    "fixture-phone",
  );
});
test("physical checkout/home/root and Windows case aliases are rejected before state writes", async (t) => {
  const f = await fixture(t);
  for (const path of [
    f.code,
    join(f.code, "nested/new-state"),
    f.home,
    parse(f.base).root,
  ])
    await assert.rejects(assertPrivateStateDirectory(path, f.options), {
      code: "unsafe_state_directory",
    });
  if (process.platform === "win32")
    await assert.rejects(
      assertPrivateStateDirectory(f.code.toUpperCase(), f.options),
      { code: "unsafe_state_directory" },
    );
  const alias = join(f.base, "alias");
  await fs.symlink(
    f.code,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(setupState(join(alias, "future-state"), f.options), {
    code: "unsafe_state_directory",
  });
  await assert.rejects(fs.access(join(f.code, "future-state")), {
    code: "ENOENT",
  });
});
test("temporary Windows rename conflicts retry finitely without losing the old file", async (t) => {
  const f = await fixture(t);
  const path = join(f.base, "atomic.json");
  await saveJSON(path, { generation: 1 });
  let calls = 0;
  const waits = [];
  await saveJSON(
    path,
    { generation: 2 },
    {
      fsAPI: {
        rename: async (...args) => {
          if (++calls < 4)
            throw Object.assign(Error("temporary sharing violation"), {
              code: "EPERM",
            });
          return fs.rename(...args);
        },
      },
      sleep: async (ms) => waits.push(ms),
    },
  );
  assert.equal(calls, 4);
  assert.deepEqual(waits, [25, 50, 100]);
  assert.equal((await readJSON(path)).generation, 2);
  let failures = 0;
  await assert.rejects(
    saveJSON(
      path,
      { generation: 3 },
      {
        attempts: 3,
        fsAPI: {
          rename: async () => {
            failures++;
            throw Object.assign(Error("still busy"), { code: "EBUSY" });
          },
        },
        sleep: async () => {},
      },
    ),
    { code: "EBUSY" },
  );
  assert.equal(failures, 3);
  assert.equal((await readJSON(path)).generation, 2);
  assert(!(await fs.readdir(f.base)).some((name) => name.endsWith(".tmp")));
});
test("dead initialization owners recover while live owners are never removed", async (t) => {
  const f = await fixture(t);
  const path = join(f.base, "operation.lock");
  await saveJSON(path, { pid: 2147483647, token: "dead-fixture" });
  assert.equal(await withFileLock(path, async () => "recovered"), "recovered");
  await saveJSON(path, { pid: process.pid, token: "live-fixture" });
  await assert.rejects(
    withFileLock(path, async () => assert.fail("must not acquire"), {
      timeoutMs: 70,
    }),
    { code: "state_busy" },
  );
  assert.equal((await readJSON(path)).token, "live-fixture");
});

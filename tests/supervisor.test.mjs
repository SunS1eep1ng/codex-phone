import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervise } from "../src/supervisor.mjs";
import { saveJSON } from "../src/state.mjs";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "codex-phone-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveJSON(join(dir, "config.json"), {
    application: "codex-phone",
    deviceId: "supervisor-test",
    ports: { control: 0 },
  });
  return dir;
}
test("supervisor recovers only its companion after failed probes and removes its owned lease", async (t) => {
  const dir = await fixture(t);
  let probes = 0,
    launches = 0;
  const result = await supervise({
    dir,
    root: dir,
    maxCycles: 3,
    wait: async () => {},
    probe: async () => {
      if (++probes === 1) throw Error("connection refused");
      return { service: "codex-phone", deviceId: "supervisor-test" };
    },
    launch: async (root, state) => {
      assert.equal(root, dir);
      assert.equal(state, dir);
      launches++;
    },
  });
  assert.equal(launches, 1);
  assert.equal(result.restarts, 1);
  await assert.rejects(access(join(dir, "supervisor.json")), {
    code: "ENOENT",
  });
});
test("stop racing a failed probe prevents a recovery launch", async (t) => {
  const dir = await fixture(t);
  let launches = 0;
  await supervise({
    dir,
    root: dir,
    maxCycles: 2,
    wait: async () => {},
    probe: async () => {
      await saveJSON(join(dir, "supervisor-stop.json"), {
        application: "codex-phone-supervisor-stop",
        deviceId: "supervisor-test",
      });
      throw Error("connection refused");
    },
    launch: async () => launches++,
  });
  assert.equal(launches, 0);
});
test("supervisor backs off without restarting healthy native work and never kills a port owner", async (t) => {
  const dir = await fixture(t);
  const delays = [];
  let launches = 0;
  await supervise({
    dir,
    root: dir,
    maxCycles: 4,
    wait: async (ms) => delays.push(ms),
    probe: async () => {
      throw Error("foreign control identity");
    },
    launch: async () => {
      launches++;
      throw Error("owned lease unavailable");
    },
  });
  assert.equal(launches, 4);
  assert.deepEqual(delays, [2000, 4000, 8000, 15000]);
});

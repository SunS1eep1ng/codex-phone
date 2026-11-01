import { open, mkdir, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJSON, saveJSON, PhoneError } from "./state.mjs";
import { requestControl } from "./control-auth.mjs";
import { readActiveInstallation } from "../scripts/install-pointer.mjs";

const paths = (dir) => ({
  lease: join(dir, "supervisor.json"),
  stop: join(dir, "supervisor-stop.json"),
  log: join(dir, "supervisor.log"),
});
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export async function supervisorStatus(dir) {
  let value;
  try {
    value = await readJSON(paths(dir).lease, null);
  } catch (e) {
    if (e instanceof SyntaxError) return { running: false, starting: true };
    throw e;
  }
  return {
    ...value,
    running:
      !!value &&
      value.application === "codex-phone-supervisor" &&
      alive(value.pid) &&
      Date.now() - value.updatedAt < 20000,
  };
}
export async function stopSupervisor(dir) {
  const p = paths(dir),
    config = await readJSON(join(dir, "config.json"), null);
  if (!config) return;
  await saveJSON(p.stop, {
    application: "codex-phone-supervisor-stop",
    deviceId: config.deviceId,
    requestedAt: Date.now(),
  });
  for (let i = 0; i < 30; i++) {
    const current = await readJSON(p.lease, null);
    if (!current || !alive(current.pid)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new PhoneError(
    "supervisor_stop_timeout",
    "The owned supervisor has not acknowledged stop; keep its state intact.",
  );
}
export async function startSupervisor(dir, root) {
  const config = await readJSON(join(dir, "config.json"), null);
  if (config?.application !== "codex-phone")
    throw new PhoneError("state_ownership_invalid");
  const p = paths(dir);
  await unlink(p.stop).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  const state = await supervisorStatus(dir);
  if (state.running) {
    if (state.deviceId !== config.deviceId)
      throw new PhoneError("supervisor_identity_mismatch");
    return { ok: true, alreadyRunning: true };
  }
  const output = await open(p.log, "a", 0o600);
  const child = spawn(
    process.execPath,
    [join(root, "scripts/watch-service.mjs"), "--state", dir, "--root", root],
    {
      detached: true,
      stdio: ["ignore", output.fd, output.fd],
      windowsHide: true,
      env: { ...process.env, CODEX_PHONE_STATE: dir },
    },
  );
  child.on("error", () => {});
  child.unref();
  await output.close();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const started = await supervisorStatus(dir);
    if (started.running && started.deviceId === config.deviceId)
      return { ok: true, pid: started.pid };
  }
  throw new PhoneError(
    "supervisor_start_failed",
    "Supervisor did not become ready. Check its private log.",
  );
}

export async function supervise({
  dir,
  root,
  probe = requestControl,
  launch,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  maxCycles = Infinity,
}) {
  const p = paths(dir),
    config = await readJSON(join(dir, "config.json"), null);
  if (config?.application !== "codex-phone")
    throw new PhoneError("state_ownership_invalid");
  await mkdir(dir, { recursive: true });
  let lease;
  try {
    lease = await open(p.lease, "wx", 0o600);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let previous;
    try {
      previous = await readJSON(p.lease, null);
    } catch (e) {
      if (e instanceof SyntaxError) return { ok: true, alreadyRunning: true };
      throw e;
    }
    if (previous && alive(previous.pid))
      return { ok: true, alreadyRunning: true };
    await unlink(p.lease).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    try {
      lease = await open(p.lease, "wx", 0o600);
    } catch (e) {
      if (e.code === "EEXIST") return { ok: true, alreadyRunning: true };
      throw e;
    }
  }
  const token = randomUUID();
  let failures = 0,
    restarts = 0;
  const stopped = async () => {
    const value = await readJSON(p.stop, null);
    return (
      value?.application === "codex-phone-supervisor-stop" &&
      value.deviceId === config.deviceId
    );
  };
  const heartbeat = () =>
    saveJSON(p.lease, {
      application: "codex-phone-supervisor",
      deviceId: config.deviceId,
      pid: process.pid,
      token,
      updatedAt: now(),
      restarts,
    });
  // Keep the exclusive create handle only for initialization; atomic heartbeats replace its pathname.
  await lease.writeFile(
    JSON.stringify({
      application: "codex-phone-supervisor",
      deviceId: config.deviceId,
      pid: process.pid,
      token,
      updatedAt: now(),
      restarts,
    }),
  );
  await lease.close();
  try {
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      if (await stopped()) break;
      await heartbeat();
      const current = await readJSON(join(dir, "config.json"), null);
      if (!current || current.deviceId !== config.deviceId) break;
      const installation = await readActiveInstallation(dir, {
        fallbackRoot: root,
      });
      if (installation.recovering || installation.activating) {
        await wait(2000);
        continue;
      }
      let healthy = false;
      try {
        const status = await probe(current, "status", undefined, {
          timeout: 3000,
        });
        healthy =
          status.service === "codex-phone" &&
          status.deviceId === config.deviceId;
      } catch {}
      if (healthy) failures = 0;
      else {
        if (await stopped()) break;
        const stopCheck = () => stopped();
        try {
          if (!(await stopCheck())) {
            await launch(installation.root, dir, stopCheck);
            restarts++;
          }
        } catch (e) {
          console.error("Companion recovery:", e.code || "start_failed");
        }
        failures++;
      }
      await heartbeat();
      await wait(
        healthy ? 2000 : Math.min(15000, 1000 * 2 ** Math.min(failures, 4)),
      );
    }
    return { ok: true, restarts };
  } finally {
    const current = await readJSON(p.lease, null);
    if (current?.token === token) await unlink(p.lease).catch(() => {});
  }
}

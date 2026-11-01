// Deliberately standalone: this helper must survive removal of a managed
// generation's code/dependencies. It uses only Node built-ins.
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const key = (value) =>
  process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const within = (value, parent) =>
  key(value) === key(parent) || key(value).startsWith(key(parent) + sep);
const read = async (io, path) => JSON.parse(await io.readFile(path, "utf8"));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export async function prepareUninstallCleanup(
  stateDir,
  deviceId,
  options = {},
) {
  const io = { ...fs, ...options.fsAPI },
    state = await io.realpath(stateDir);
  const generationBase = join(state, "install/generations");
  const roots = [];
  for (const entry of await io
    .readdir(generationBase, { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const root = join(generationBase, entry.name);
    const physical = await io.realpath(root);
    if (!within(physical, state) || !within(physical, generationBase))
      throw Error("UNSAFE_UNINSTALL_GENERATION");
    const marker = await read(
      io,
      join(root, ".codex-phone-generation.json"),
    ).catch(() => null);
    if (
      marker?.application === "codex-phone" &&
      marker.schema === 1 &&
      marker.deviceId === deviceId &&
      marker.generationId === entry.name
    )
      roots.push({ root, generationId: entry.name });
  }
  const id = randomUUID();
  const job = {
    application: "codex-phone",
    schema: 1,
    id,
    stateDir: state,
    deviceId,
    bootstrapRoot: options.bootstrapRoot
      ? await io.realpath(options.bootstrapRoot)
      : null,
    parentPid: process.pid,
    roots,
  };
  const jobFile = join(state, `uninstall-${id}.json`),
    helperFile = join(state, `uninstall-${id}.mjs`),
    resultFile = join(state, `uninstall-${id}.result.json`);
  await io.copyFile(
    options.sourceFile || fileURLToPath(import.meta.url),
    helperFile,
  );
  await io.writeFile(jobFile, JSON.stringify(job), { mode: 0o600, flag: "wx" });
  return { job, jobFile, helperFile, resultFile };
}
export function launchUninstallCleanup(prepared) {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [prepared.helperFile, prepared.jobFile],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });
}
export async function runUninstallCleanup(job, options = {}) {
  const io = { ...fs, ...options.fsAPI },
    sleep = options.sleep || wait;
  const alive =
    options.isAlive ||
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code !== "ESRCH";
      }
    });
  if (
    job?.application !== "codex-phone" ||
    job.schema !== 1 ||
    !/^[a-f0-9-]{36}$/.test(job.id) ||
    !Array.isArray(job.roots)
  )
    throw Error("INVALID_UNINSTALL_JOB");
  const state = await io.realpath(job.stateDir);
  if (
    key(state) === key(parse(state).root) ||
    key(state) === key(await io.realpath(homedir()))
  )
    throw Error("UNSAFE_UNINSTALL_STATE");
  const until = Date.now() + (options.waitTimeoutMs ?? 30000);
  while (alive(job.parentPid) && Date.now() < until) await sleep(100);
  if (alive(job.parentPid))
    return {
      ok: false,
      code: "uninstall_parent_still_running",
      remaining: job.roots.map((item) => item.root),
    };
  const remaining = [];
  for (const item of job.roots) {
    const expected = join(state, "install/generations", item.generationId);
    if (
      !/^[A-Za-z0-9._-]{1,80}$/.test(item.generationId) ||
      key(expected) !== key(item.root)
    )
      throw Error("UNSAFE_UNINSTALL_GENERATION");
    let root;
    try {
      root = await io.realpath(expected);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (
      !within(root, join(state, "install/generations")) ||
      !within(root, state) ||
      (job.bootstrapRoot && within(job.bootstrapRoot, root))
    )
      throw Error("UNSAFE_UNINSTALL_GENERATION");
    const marker = await read(io, join(root, ".codex-phone-generation.json"));
    if (
      marker.application !== "codex-phone" ||
      marker.schema !== 1 ||
      marker.deviceId !== job.deviceId ||
      marker.generationId !== item.generationId
    )
      throw Error("UNINSTALL_OWNERSHIP_CHANGED");
    try {
      await io.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150,
      });
      await io
        .unlink(join(state, "install/logs", item.generationId + ".log"))
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      const validation = join(state, "install/validation", item.generationId);
      const physical = await io.realpath(validation).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (physical) {
        if (!within(physical, join(state, "install/validation")))
          throw Error("UNSAFE_UNINSTALL_VALIDATION");
        await io.rm(physical, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 150,
        });
      }
    } catch (error) {
      remaining.push({ root, code: error.code || error.message });
    }
  }
  for (const path of [
    "install/generations",
    "install/validation",
    "install/logs",
    "install",
  ])
    await io.rmdir(join(state, path)).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    });
  return {
    ok: remaining.length === 0,
    code: remaining.length
      ? "uninstall_cleanup_pending"
      : "uninstall_cleanup_complete",
    remaining,
  };
}

if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  /^uninstall-[a-f0-9-]{36}\.mjs$/.test(basename(process.argv[1]))
) {
  const jobFile = resolve(process.argv[2] || "");
  let job;
  try {
    job = await read(fs, jobFile);
    if (key(jobFile) !== key(join(job.stateDir, `uninstall-${job.id}.json`)))
      throw Error("INVALID_UNINSTALL_JOB_PATH");
    const result = await runUninstallCleanup(job);
    await fs.writeFile(
      join(job.stateDir, `uninstall-${job.id}.result.json`),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    await fs.unlink(jobFile);
    await fs.unlink(fileURLToPath(import.meta.url));
  } catch (error) {
    if (job?.stateDir && job?.id && /^[a-f0-9-]{36}$/.test(job.id))
      await fs
        .writeFile(
          join(job.stateDir, `uninstall-${job.id}.result.json`),
          JSON.stringify({ ok: false, code: error.code || error.message }),
          { mode: 0o600 },
        )
        .catch(() => {});
    process.exitCode = 1;
  }
}

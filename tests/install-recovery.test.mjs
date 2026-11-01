import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performInstall } from "../scripts/install-transaction.mjs";
import {
  installationPaths,
  readActiveInstallation,
} from "../scripts/install-pointer.mjs";
import { readJSON, saveJSON } from "../src/state.mjs";
import {
  prepareUninstallCleanup,
  runUninstallCleanup,
} from "../scripts/uninstall-cleanup.mjs";

async function fixture(t, { managed = false } = {}) {
  const base = await fs.mkdtemp(join(tmpdir(), "codex-phone-install-"));
  assert(resolve(base).startsWith(resolve(tmpdir())));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = join(base, "source"),
    stateDir = join(base, "state");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(stateDir);
  const config = {
    application: "codex-phone",
    schema: 1,
    deviceId: "install-fixture",
    adminSecret: "synthetic-admin",
    agentSecret: "synthetic-agent",
    ports: { control: 0, gateway: 0, desktop: 0 },
    relay: { provider: "provided", endpoint: "" },
  };
  await saveJSON(join(stateDir, "config.json"), config);
  await saveJSON(join(sourceRoot, "package.json"), { name: "codex-phone" });
  await saveJSON(join(sourceRoot, "package-lock.json"), {});
  await saveJSON(join(sourceRoot, "public-files.json"), {
    files: ["package.json", "package-lock.json", "public-files.json"],
  });
  await fs.mkdir(join(sourceRoot, "dist"));
  await fs.writeFile(
    join(sourceRoot, "dist/cli.mjs"),
    "// synthetic previous CLI; runner never executes this file",
  );
  let oldRoot = sourceRoot;
  const paths = installationPaths(stateDir);
  let previousPointer = null;
  if (managed) {
    oldRoot = join(paths.generations, "previous");
    await fs.mkdir(join(oldRoot, "dist"), { recursive: true });
    await fs.writeFile(join(oldRoot, "dist/cli.mjs"), "// previous generation");
    await saveJSON(join(oldRoot, ".codex-phone-generation.json"), {
      application: "codex-phone",
      schema: 1,
      deviceId: config.deviceId,
      generationId: "previous",
      ready: true,
    });
    previousPointer = {
      schema: 1,
      deviceId: config.deviceId,
      generationId: "previous",
      root: oldRoot,
      previous: sourceRoot,
      bootstrapRoot: sourceRoot,
    };
    await saveJSON(paths.active, previousPointer);
  }
  await fs.mkdir(join(oldRoot, "node_modules"), { recursive: true });
  await fs.writeFile(
    join(oldRoot, "node_modules/last-good.txt"),
    "last-known-good",
  );
  return {
    base,
    sourceRoot,
    stateDir,
    config,
    oldRoot,
    paths,
    previousPointer,
  };
}
function mockRunner(
  f,
  { failStage, failStart = false, failRestart = false } = {},
) {
  const trace = [];
  const runner = async (_node, args, options) => {
    const cwd = options.cwd;
    const isCLI =
      String(args[0]).endsWith("cli.mjs") &&
      !String(args[0]).endsWith("npm-cli.js");
    const command = isCLI
      ? args[args.indexOf("--state") + 2]
      : args[1] === "run"
        ? args[2]
        : args[1];
    const validation =
      isCLI && args[args.indexOf("--state") + 1] !== f.stateDir;
    trace.push({ cwd, command, validation, args: [...args] });
    if (!isCLI) {
      if (command === "build") {
        await fs.mkdir(join(cwd, "dist"), { recursive: true });
        await fs.writeFile(join(cwd, "dist/cli.mjs"), "// candidate fixture");
      }
      return {
        code: command === failStage ? 8 : 0,
        stdout: "",
        stderr: command === failStage ? "injected preparation failure" : "",
      };
    }
    if (command === "setup" && !validation) {
      const selected = await readActiveInstallation(f.stateDir, {
        fallbackRoot: cwd,
        activationToken: options.env.CODEX_PHONE_INSTALL_TOKEN,
      });
      assert.equal(selected.root, cwd);
      const ordinary = await readActiveInstallation(f.stateDir, {
        fallbackRoot: f.sourceRoot,
        activationToken: "",
      });
      assert.equal(ordinary.root, f.oldRoot);
    }
    if (
      command === "start" &&
      ((cwd !== f.oldRoot && failStart) || (cwd === f.oldRoot && failRestart))
    )
      return { code: 9, stdout: "", stderr: "injected activation failure" };
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        deviceId: f.config.deviceId,
        pid: 1234,
      }),
      stderr: "",
    };
  };
  return { runner, trace };
}
const install = (f, runner, extra = {}) =>
  performInstall({
    ...f,
    runner,
    upgrade: true,
    noShortcuts: true,
    generationId: "candidate",
    npmCLI: join(f.base, "npm-cli.js"),
    ...extra,
  });

test("candidate dependencies/build/tests finish before stopping the old generation", async (t) => {
  const f = await fixture(t);
  const { runner, trace } = mockRunner(f);
  const result = await install(f, runner);
  assert.equal(result.ok, true);
  assert(
    trace.find((call) => call.command === "ci").args.includes("--include=dev"),
  );
  const stop = trace.findIndex((x) => x.command === "stop");
  for (const command of ["ci", "build", "test", "audit:publish"])
    assert(trace.findIndex((x) => x.command === command) < stop);
  assert(
    trace
      .filter((x) =>
        ["ci", "build", "test", "audit:publish"].includes(x.command),
      )
      .every((x) => x.cwd !== f.oldRoot),
  );
  assert.equal(
    await fs.readFile(join(f.oldRoot, "node_modules/last-good.txt"), "utf8"),
    "last-known-good",
  );
  const active = await readActiveInstallation(f.stateDir, {
    fallbackRoot: f.sourceRoot,
  });
  assert.equal(active.root, result.root);
  assert.equal(active.pointer.previous, f.oldRoot);
  assert.equal((await readJSON(f.paths.transaction)).phase, "committed");
});
test("preparation failure leaves the old service, pointer and dependencies untouched", async (t) => {
  const f = await fixture(t, { managed: true });
  const { runner, trace } = mockRunner(f, { failStage: "build" });
  await assert.rejects(install(f, runner), {
    code: "installation_preparation_failed",
  });
  assert(!trace.some((x) => x.command === "stop" || x.command === "start"));
  assert.deepEqual(await readJSON(f.paths.active), f.previousPointer);
  assert.equal(
    await fs.readFile(join(f.oldRoot, "node_modules/last-good.txt"), "utf8"),
    "last-known-good",
  );
});
test("failed new service activation restores the exact old pointer and restarts old code", async (t) => {
  const f = await fixture(t, { managed: true });
  const { runner, trace } = mockRunner(f, { failStart: true });
  await assert.rejects(install(f, runner), {
    code: "installation_activation_failed",
  });
  assert.deepEqual(await readJSON(f.paths.active), f.previousPointer);
  assert(trace.some((x) => x.cwd === f.oldRoot && x.command === "start"));
  assert.equal((await readJSON(f.paths.transaction)).phase, "rolled-back");
  assert.equal(
    (await readJSON(join(f.stateDir, "config.json"))).adminSecret,
    "synthetic-admin",
  );
});
test("legacy source installation also rolls back without selecting the failed candidate", async (t) => {
  const f = await fixture(t);
  const { runner, trace } = mockRunner(f, { failStart: true });
  await assert.rejects(install(f, runner), {
    code: "installation_activation_failed",
  });
  await assert.rejects(fs.access(f.paths.active), { code: "ENOENT" });
  assert.equal(
    (await readActiveInstallation(f.stateDir, { fallbackRoot: f.sourceRoot }))
      .root,
    f.sourceRoot,
  );
  assert(trace.some((x) => x.cwd === f.sourceRoot && x.command === "start"));
});
test("rollback restart failure is reported rather than claimed recovered", async (t) => {
  const f = await fixture(t, { managed: true });
  const { runner } = mockRunner(f, { failStart: true, failRestart: true });
  await assert.rejects(install(f, runner), {
    code: "installation_rollback_failed",
  });
  assert.equal((await readJSON(f.paths.transaction)).phase, "rollback-failed");
  assert.equal(
    (await readActiveInstallation(f.stateDir, { fallbackRoot: f.sourceRoot }))
      .root,
    f.oldRoot,
  );
});
test("interrupted activation recovers previous code before preparing another update", async (t) => {
  const f = await fixture(t, { managed: true });
  const badRoot = join(f.paths.generations, "interrupted");
  await fs.mkdir(join(badRoot, "dist"), { recursive: true });
  await fs.writeFile(join(badRoot, "dist/cli.mjs"), "// interrupted fixture");
  await saveJSON(join(badRoot, ".codex-phone-generation.json"), {
    application: "codex-phone",
    schema: 1,
    deviceId: f.config.deviceId,
    generationId: "interrupted",
    ready: true,
  });
  const candidatePointer = {
    schema: 1,
    deviceId: f.config.deviceId,
    generationId: "interrupted",
    root: badRoot,
    bootstrapRoot: f.sourceRoot,
  };
  await saveJSON(f.paths.active, candidatePointer);
  await saveJSON(f.paths.transaction, {
    schema: 1,
    deviceId: f.config.deviceId,
    generationId: "interrupted",
    candidateRoot: badRoot,
    candidatePointer,
    bootstrapRoot: f.sourceRoot,
    previousRoot: f.oldRoot,
    previousPointer: f.previousPointer,
    phase: "activating",
    activationToken: "synthetic-token",
    wasRunning: true,
    startRequested: true,
  });
  assert.equal(
    (await readActiveInstallation(f.stateDir, { fallbackRoot: f.sourceRoot }))
      .root,
    f.oldRoot,
  );
  const { runner, trace } = mockRunner(f, { failStage: "build" });
  await assert.rejects(install(f, runner), {
    code: "installation_preparation_failed",
  });
  assert.equal(trace[0].cwd, badRoot);
  assert.equal(trace[0].command, "stop");
  assert.equal(trace[1].cwd, f.oldRoot);
  assert.equal(trace[1].command, "start");
  assert.deepEqual(await readJSON(f.paths.active), f.previousPointer);
});
test("active pointers cannot select arbitrary directories outside owned generations", async (t) => {
  const f = await fixture(t);
  await saveJSON(f.paths.active, {
    schema: 1,
    deviceId: f.config.deviceId,
    generationId: "outside",
    root: f.sourceRoot,
  });
  await assert.rejects(
    readActiveInstallation(f.stateDir, { fallbackRoot: f.sourceRoot }),
    { code: "installation_pointer_invalid" },
  );
});
test("a failed first installation does not claim a nonexistent previous generation was restored", async (t) => {
  const f = await fixture(t);
  await fs.unlink(join(f.sourceRoot, "dist/cli.mjs"));
  const calls = [];
  const runner = async (_node, args, options) => {
    const command = args.includes("--state")
      ? args[args.indexOf("--state") + 2]
      : args[1] === "run"
        ? args[2]
        : args[1];
    calls.push({ root: options.cwd, command });
    if (command === "build") {
      await fs.mkdir(join(options.cwd, "dist"), { recursive: true });
      await fs.writeFile(join(options.cwd, "dist/cli.mjs"), "// new fixture");
    }
    const validation =
      args.includes("--state") &&
      args[args.indexOf("--state") + 1] !== f.stateDir;
    return {
      code: command === "setup" && !validation ? 7 : 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
    };
  };
  await assert.rejects(
    install(f, runner, { upgrade: false }),
    (error) =>
      error.code === "installation_activation_failed" &&
      /No previous installation/.test(error.message),
  );
  assert(!calls.some((call) => call.command === "start"));
  await assert.rejects(fs.access(f.paths.active), { code: "ENOENT" });
});
test("rollback restores supervision only when the previous CLI advertises support", async (t) => {
  const f = await fixture(t, { managed: true });
  const mock = mockRunner(f, { failStart: true });
  const runner = async (node, args, options) =>
    args.includes("--help")
      ? { code: 0, stdout: "start --supervise", stderr: "" }
      : mock.runner(node, args, options);
  await assert.rejects(
    install(f, runner, { supervisorStatus: async () => ({ running: true }) }),
    { code: "installation_activation_failed" },
  );
  const oldStart = mock.trace.find(
    (call) => call.cwd === f.oldRoot && call.command === "start",
  );
  assert(oldStart.args.includes("--supervise"));
});
test("post-exit cleanup removes only marker-owned generations, preserving the source checkout", async (t) => {
  const f = await fixture(t, { managed: true });
  const prepared = await prepareUninstallCleanup(
    f.stateDir,
    f.config.deviceId,
    { bootstrapRoot: f.sourceRoot },
  );
  const result = await runUninstallCleanup(prepared.job, {
    isAlive: () => false,
  });
  assert.equal(result.ok, true);
  await assert.rejects(fs.access(f.oldRoot), { code: "ENOENT" });
  await fs.access(join(f.sourceRoot, "dist/cli.mjs"));
});
test("cleanup refuses changed ownership and does nothing while its parent remains alive", async (t) => {
  const f = await fixture(t, { managed: true });
  const prepared = await prepareUninstallCleanup(
    f.stateDir,
    f.config.deviceId,
    { bootstrapRoot: f.sourceRoot },
  );
  const waiting = await runUninstallCleanup(prepared.job, {
    isAlive: () => true,
    waitTimeoutMs: 0,
  });
  assert.equal(waiting.code, "uninstall_parent_still_running");
  await fs.access(f.oldRoot);
  await saveJSON(join(f.oldRoot, ".codex-phone-generation.json"), {
    application: "codex-phone",
    schema: 1,
    deviceId: "another-installation",
    generationId: "previous",
    ready: true,
  });
  await assert.rejects(
    runUninstallCleanup(prepared.job, { isAlive: () => false }),
    /UNINSTALL_OWNERSHIP_CHANGED/,
  );
  await fs.access(f.oldRoot);
});

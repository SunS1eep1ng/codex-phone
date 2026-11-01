import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  assertPrivateStateDirectory,
  canonicalPath,
  pathIsWithin,
  pathKey,
  readJSON,
  saveJSON,
  setupState,
  withFileLock,
  PhoneError,
  secret,
} from "../src/state.mjs";
import {
  installationPaths,
  readActiveInstallation,
  validateGeneration,
} from "./install-pointer.mjs";
import { supervisorStatus } from "../src/supervisor.mjs";

export async function commandRunner(executable, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new PhoneError(
          "installation_command_timeout",
          "An installation command exceeded its time limit.",
        ),
      );
    }, options.timeoutMs || 900000);
    child.stdout.on(
      "data",
      (bytes) => (stdout = (stdout + bytes).slice(-8 * 1024 * 1024)),
    );
    child.stderr.on(
      "data",
      (bytes) => (stderr = (stderr + bytes).slice(-8 * 1024 * 1024)),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}
const exists = async (io, path) =>
  io.access(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
const parseResult = (result) => {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
};

async function prepareSource(sourceRoot, candidateRoot, io) {
  const manifest = await readJSON(join(sourceRoot, "public-files.json"), null, {
    fsAPI: io,
  });
  if (!Array.isArray(manifest?.files) || !manifest.files.length)
    throw new PhoneError(
      "installation_manifest_invalid",
      "A public-file manifest is required.",
    );
  await io.mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    if (
      typeof file !== "string" ||
      file.startsWith("/") ||
      /^[a-z]:/i.test(file) ||
      file.split(/[\\/]/).includes("..")
    )
      throw new PhoneError(
        "installation_manifest_invalid",
        "Unsafe source file in public manifest.",
      );
    const source = resolve(sourceRoot, file),
      target = resolve(candidateRoot, file);
    if (
      !pathIsWithin(source, sourceRoot) ||
      !pathIsWithin(target, candidateRoot) ||
      (await io.lstat(source)).isSymbolicLink() ||
      !(await io.stat(source)).isFile()
    )
      throw new PhoneError(
        "installation_manifest_invalid",
        "Only regular public source files may be staged.",
      );
    await io.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await io.copyFile(source, target);
  }
}

export async function performInstall(options) {
  const io = { ...fs, ...options.fsAPI },
    runner = options.runner || commandRunner;
  const sourceRoot = await canonicalPath(options.sourceRoot, { fsAPI: io });
  const stateDir = await assertPrivateStateDirectory(options.stateDir, {
    fsAPI: io,
    checkoutRoots: [sourceRoot],
  });
  const config =
    options.config ||
    (await (options.initializeState || setupState)(stateDir, {
      fsAPI: io,
      checkoutRoots: [sourceRoot],
    }));
  if (config.application !== "codex-phone" || config.schema !== 1)
    throw new PhoneError("state_ownership_invalid");
  const paths = installationPaths(stateDir);
  await io.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const write = (file, value) => saveJSON(file, value, { fsAPI: io });
  const envFor = (transaction) => ({
    ...process.env,
    CODEX_PHONE_STATE: stateDir,
    ...(transaction
      ? { CODEX_PHONE_INSTALL_TOKEN: transaction.activationToken }
      : { CODEX_PHONE_INSTALL_TOKEN: "" }),
  });
  const invoke = async (
    root,
    args,
    { transaction, allowFailure = false, cwd = root, env } = {},
  ) => {
    const result = await runner(
      process.execPath,
      [join(root, "dist/cli.mjs"), "--state", stateDir, ...args],
      { cwd, env: env || envFor(transaction) },
    );
    if (!allowFailure && result.code !== 0)
      throw new PhoneError(
        "installation_command_failed",
        `Installation command ${args[0]} failed with exit ${result.code}.`,
        [
          "Inspect the private installation log; the previous generation is retained.",
        ],
      );
    return result;
  };
  const verifyRunning = async (result, expectedRoot) => {
    const body = parseResult(result);
    if (
      result.code !== 0 ||
      body?.ok !== true ||
      body.deviceId !== config.deviceId
    )
      throw new Error("Service identity/readiness check failed");
    if (
      body.codeRoot &&
      pathKey(await canonicalPath(body.codeRoot, { fsAPI: io })) !==
        pathKey(await canonicalPath(expectedRoot, { fsAPI: io }))
    )
      throw new Error("The service is running a different code generation");
  };
  const appendLog = async (transaction, stage, result) => {
    await io.mkdir(join(paths.directory, "logs"), {
      recursive: true,
      mode: 0o700,
    });
    await io.appendFile(
      join(paths.directory, "logs", transaction.generationId + ".log"),
      JSON.stringify({
        stage,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      }) + "\n",
      { mode: 0o600 },
    );
  };
  const restorePointer = async (transaction) => {
    if (transaction.previousPointer)
      await write(paths.active, transaction.previousPointer);
    else
      await io.unlink(paths.active).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  };
  const rollback = async (transaction, cause) => {
    transaction.phase = "rolling-back";
    await write(paths.transaction, transaction);
    let stopFailure;
    if (transaction.candidatePointer) {
      try {
        await validateGeneration(stateDir, transaction.candidatePointer, {
          fsAPI: io,
          config,
        });
        const stop = await invoke(
          transaction.candidateRoot,
          ["stop", "--json"],
          { transaction, allowFailure: true },
        );
        await appendLog(transaction, "rollback-stop-candidate", stop);
        if (stop.code !== 0)
          stopFailure = new Error(
            "Candidate service could not be stopped safely.",
          );
      } catch (error) {
        stopFailure = error;
      }
    }
    // Never launch an old service until the candidate has confirmed shutdown.
    await restorePointer(transaction);
    let restartFailure;
    if (
      !stopFailure &&
      transaction.previousRoot &&
      (transaction.wasRunning || transaction.startRequested)
    ) {
      try {
        const restarted = await invoke(transaction.previousRoot, [
          "start",
          ...(transaction.restartSupervised ? ["--supervise"] : []),
          "--json",
        ]);
        await appendLog(transaction, "rollback-restart-previous", restarted);
        await verifyRunning(
          await invoke(transaction.previousRoot, ["status", "--json"]),
          transaction.previousRoot,
        );
      } catch (error) {
        restartFailure = error;
      }
    }
    transaction.phase =
      stopFailure || restartFailure ? "rollback-failed" : "rolled-back";
    transaction.failure = cause?.message || "Interrupted installation";
    transaction.rollbackError =
      (stopFailure || restartFailure)?.message || null;
    await write(paths.transaction, transaction);
    if (stopFailure || restartFailure)
      throw new PhoneError(
        "installation_rollback_failed",
        "Previous code is selected, but automatic service recovery could not be confirmed.",
        [
          "Keep the previous generation and rerun the stable launcher or installer; inspect the private install log.",
        ],
      );
  };
  return withFileLock(
    paths.lock,
    async () => {
      const pending = await readJSON(paths.transaction, null, { fsAPI: io });
      if (
        pending?.schema === 1 &&
        [
          "stopping",
          "switching",
          "activating",
          "rolling-back",
          "rollback-failed",
        ].includes(pending.phase)
      ) {
        if (pending.deviceId !== config.deviceId)
          throw new PhoneError(
            "installation_transaction_invalid",
            "Pending transaction belongs to another installation.",
          );
        await rollback(pending, new Error("Recovered interrupted activation"));
      }
      const active = await readActiveInstallation(stateDir, {
        fallbackRoot: sourceRoot,
        fsAPI: io,
        activationToken: "",
      });
      const previousPointer = await readJSON(paths.active, null, { fsAPI: io });
      const previousRoot = (await exists(io, join(active.root, "dist/cli.mjs")))
        ? active.root
        : null;
      const generationId =
        options.generationId ||
        new Date().toISOString().replace(/[^0-9]/g, "") +
          "-" +
          randomUUID().slice(0, 8);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(generationId))
        throw new PhoneError("installation_generation_invalid");
      const candidateRoot = join(paths.generations, generationId);
      if (
        !pathIsWithin(
          await canonicalPath(paths.generations, { fsAPI: io }),
          stateDir,
        )
      )
        throw new PhoneError(
          "installation_generation_invalid",
          "Generations cannot be redirected outside private state.",
        );
      if (await exists(io, candidateRoot))
        throw new PhoneError(
          "installation_generation_exists",
          "Choose a new generation instead of overwriting code.",
        );
      const bootstrapRoot = sourceRoot;
      const transaction = {
        schema: 1,
        deviceId: config.deviceId,
        generationId,
        candidateRoot,
        bootstrapRoot,
        previousRoot,
        previousPointer,
        phase: "preparing",
        activationToken: secret(),
        wasRunning: false,
        startRequested: !!options.upgrade,
      };
      await write(paths.transaction, transaction);
      const validationState = join(paths.directory, "validation", generationId);
      try {
        await io.mkdir(candidateRoot, { recursive: true, mode: 0o700 });
        await write(join(candidateRoot, ".codex-phone-generation.json"), {
          application: "codex-phone",
          schema: 1,
          deviceId: config.deviceId,
          generationId,
          ready: false,
        });
        await prepareSource(sourceRoot, candidateRoot, io);
        const npm =
          options.npmCLI ||
          join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
        const prepareEnv = {
          ...process.env,
          CODEX_PHONE_STATE: validationState,
          CODEX_PHONE_INSTALL_TOKEN: "",
        };
        for (const [stage, args] of [
          [
            "dependencies",
            [npm, "ci", "--include=dev", "--no-audit", "--no-fund"],
          ],
          ["build", [npm, "run", "build"]],
          ["tests", [npm, "test"]],
          ["publication-audit", [npm, "run", "audit:publish"]],
        ]) {
          const result = await runner(process.execPath, args, {
            cwd: candidateRoot,
            env: prepareEnv,
          });
          await appendLog(transaction, stage, result);
          if (result.code !== 0)
            throw new Error(`${stage} failed with exit ${result.code}`);
        }
        const smoke = await runner(
          process.execPath,
          [
            join(candidateRoot, "dist/cli.mjs"),
            "--state",
            validationState,
            "setup",
            "--no-shortcuts",
            "--json",
          ],
          { cwd: candidateRoot, env: prepareEnv },
        );
        await appendLog(transaction, "isolated-setup", smoke);
        if (smoke.code !== 0 || parseResult(smoke)?.ok !== true)
          throw new Error("Candidate isolated setup failed");
        await write(join(candidateRoot, ".codex-phone-generation.json"), {
          application: "codex-phone",
          schema: 1,
          deviceId: config.deviceId,
          generationId,
          ready: true,
        });
        transaction.candidatePointer = {
          schema: 1,
          deviceId: config.deviceId,
          generationId,
          root: candidateRoot,
          previous: previousRoot,
          bootstrapRoot,
          updatedAt: new Date().toISOString(),
        };
        transaction.phase = "prepared";
        await write(paths.transaction, transaction);
      } catch (error) {
        transaction.phase = "preparation-failed";
        transaction.failure = error.message;
        await write(paths.transaction, transaction);
        throw new PhoneError(
          "installation_preparation_failed",
          `Candidate preparation failed; the current service and dependencies were not changed. ${error.message}`,
          ["Inspect the private installation log and retry."],
        );
      }
      if (previousRoot) {
        transaction.wasSupervised =
          (await (options.supervisorStatus || supervisorStatus)(stateDir))
            .running === true;
        if (transaction.wasSupervised) {
          const help = await invoke(previousRoot, ["start", "--help"], {
            allowFailure: true,
          });
          transaction.restartSupervised =
            help.code === 0 && help.stdout.includes("--supervise");
        }
        const status = await invoke(previousRoot, ["status", "--json"], {
          allowFailure: true,
        });
        await appendLog(transaction, "previous-status", status);
        const body = parseResult(status);
        if (
          status.code === 0 &&
          body?.ok === true &&
          body.deviceId === config.deviceId
        )
          transaction.wasRunning = true;
        else if (!(status.code === 2 && body?.code === "service_not_running"))
          throw new PhoneError(
            "installation_previous_unverified",
            "The previous service status could not be verified; it was left untouched.",
          );
      }
      transaction.startRequested ||= transaction.wasRunning;
      try {
        transaction.phase = "stopping";
        await write(paths.transaction, transaction);
        if (transaction.wasRunning)
          await invoke(previousRoot, ["stop", "--json"]);
        transaction.phase = "switching";
        await write(paths.transaction, transaction);
        await write(paths.active, transaction.candidatePointer);
        transaction.phase = "activating";
        await write(paths.transaction, transaction);
        await invoke(
          candidateRoot,
          [
            "setup",
            ...(options.noShortcuts ? ["--no-shortcuts"] : []),
            "--json",
          ],
          { transaction },
        );
        if (transaction.startRequested) {
          await invoke(candidateRoot, ["start", "--supervise", "--json"], {
            transaction,
          });
          const status = await invoke(candidateRoot, ["status", "--json"], {
            transaction,
          });
          await verifyRunning(status, candidateRoot);
        }
        transaction.phase = "committed";
        delete transaction.activationToken;
        await write(paths.transaction, transaction);
        return {
          ok: true,
          code: "installation_committed",
          root: candidateRoot,
          previous: previousRoot,
          stateDirectory: stateDir,
          started: transaction.startRequested,
        };
      } catch (error) {
        await rollback(transaction, error);
        throw new PhoneError(
          "installation_activation_failed",
          previousRoot
            ? "Candidate activation failed; the previous generation and service were restored."
            : "Candidate activation failed. No previous installation existed; private diagnostics were retained.",
          ["Inspect the private installation log before retrying."],
        );
      }
    },
    { fsAPI: io, timeoutMs: options.lockTimeoutMs || 30000 },
  );
}

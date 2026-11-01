import { basename, join, resolve } from "node:path";
import * as fs from "node:fs/promises";
import {
  canonicalPath,
  pathIsWithin,
  pathKey,
  readJSON,
  PhoneError,
} from "../src/state.mjs";

export const installationPaths = (stateDir) => ({
  directory: join(stateDir, "install"),
  generations: join(stateDir, "install", "generations"),
  active: join(stateDir, "install", "active.json"),
  transaction: join(stateDir, "install", "transaction.json"),
  lock: join(stateDir, "install", "operation.lock"),
});
const interrupted = new Set([
  "stopping",
  "switching",
  "activating",
  "rolling-back",
  "rollback-failed",
]);

export async function validateGeneration(stateDir, pointer, options = {}) {
  const io = { ...fs, ...options.fsAPI };
  const config =
    options.config ||
    (await readJSON(join(stateDir, "config.json"), null, { fsAPI: io }));
  if (
    !config ||
    config.application !== "codex-phone" ||
    config.schema !== 1 ||
    pointer?.schema !== 1 ||
    typeof pointer.root !== "string" ||
    typeof pointer.generationId !== "string"
  )
    throw new PhoneError(
      "installation_pointer_invalid",
      "Installation metadata is missing or incompatible.",
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(pointer.generationId))
    throw new PhoneError(
      "installation_pointer_invalid",
      "Invalid generation identity.",
    );
  const root = await canonicalPath(pointer.root, { fsAPI: io });
  if (basename(root) !== pointer.generationId)
    throw new PhoneError(
      "installation_pointer_invalid",
      "Generation path and identity do not match.",
    );
  const generations = await canonicalPath(
    installationPaths(stateDir).generations,
    { fsAPI: io },
  );
  if (
    pathKey(root) === pathKey(generations) ||
    !pathIsWithin(root, generations)
  )
    throw new PhoneError(
      "installation_pointer_invalid",
      "Active code must belong to this installation's generations directory.",
    );
  const marker = await readJSON(
    join(root, ".codex-phone-generation.json"),
    null,
    { fsAPI: io },
  );
  if (
    marker?.application !== "codex-phone" ||
    marker.schema !== 1 ||
    marker.ready !== true ||
    marker.deviceId !== config.deviceId ||
    marker.generationId !== pointer.generationId ||
    pointer.deviceId !== config.deviceId
  )
    throw new PhoneError(
      "installation_generation_unverified",
      "The selected generation has not passed this installation's preparation checks.",
    );
  await io.access(join(root, "dist", "cli.mjs"));
  return root;
}

async function legacyRoot(root, bootstrapRoot, options) {
  const io = { ...fs, ...options.fsAPI };
  const candidate = await canonicalPath(root, { fsAPI: io });
  if (
    !bootstrapRoot ||
    pathKey(candidate) !==
      pathKey(await canonicalPath(bootstrapRoot, { fsAPI: io }))
  )
    throw new PhoneError(
      "installation_previous_invalid",
      "The previous source installation does not match the stable bootstrap.",
    );
  const pkg = await readJSON(join(candidate, "package.json"), null, {
    fsAPI: io,
  });
  if (pkg?.name !== "codex-phone")
    throw new PhoneError(
      "installation_previous_invalid",
      "The previous source installation is not codex-phone.",
    );
  await io.access(join(candidate, "dist", "cli.mjs"));
  return candidate;
}

// Pure Node entry point shared by the stable launcher and the CLI. It never
// starts/stops anything and never treats an arbitrary JSON path as executable.
export async function readActiveInstallation(stateDir, options = {}) {
  const io = { ...fs, ...options.fsAPI },
    paths = installationPaths(stateDir);
  const pointer = await readJSON(paths.active, null, { fsAPI: io });
  const transaction = await readJSON(paths.transaction, null, { fsAPI: io });
  const token =
    options.activationToken ?? process.env.CODEX_PHONE_INSTALL_TOKEN;
  if (
    transaction?.schema === 1 &&
    transaction.activationToken &&
    token === transaction.activationToken &&
    ["switching", "activating", "rolling-back"].includes(transaction.phase)
  ) {
    const candidatePointer = transaction.candidatePointer;
    const candidateRoot = await validateGeneration(stateDir, candidatePointer, {
      fsAPI: io,
    });
    if (
      options.fallbackRoot &&
      pathKey(await canonicalPath(options.fallbackRoot, { fsAPI: io })) ===
        pathKey(candidateRoot)
    )
      return {
        root: candidateRoot,
        managed: true,
        pointer: candidatePointer,
        activating: true,
      };
  }
  if (transaction?.schema === 1 && interrupted.has(transaction.phase)) {
    if (transaction.previousPointer)
      return {
        root: await validateGeneration(stateDir, transaction.previousPointer, {
          fsAPI: io,
        }),
        managed: true,
        pointer: transaction.previousPointer,
        recovering: true,
      };
    if (transaction.previousRoot)
      return {
        root: await legacyRoot(
          transaction.previousRoot,
          options.fallbackRoot === transaction.candidateRoot
            ? transaction.bootstrapRoot
            : options.fallbackRoot || transaction.bootstrapRoot,
          { fsAPI: io },
        ),
        managed: false,
        pointer: null,
        recovering: true,
      };
    throw new PhoneError(
      "installation_recovery_required",
      "An interrupted first installation has no previous generation.",
      ["Rerun Install.ps1 to recover the pending installation."],
    );
  }
  if (pointer)
    return {
      root: await validateGeneration(stateDir, pointer, { fsAPI: io }),
      managed: true,
      pointer,
    };
  return {
    root: resolve(options.fallbackRoot || "."),
    managed: false,
    pointer: null,
  };
}

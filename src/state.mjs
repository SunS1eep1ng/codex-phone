import { randomBytes, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

export const secret = () => randomBytes(32).toString("base64url");
export const stateRoot = () =>
  resolve(
    process.env.CODEX_PHONE_STATE ||
      join(
        process.env.LOCALAPPDATA || join(homedir(), ".local/share"),
        "codex-phone",
      ),
  );
const defaultCheckout = resolve(fileURLToPath(new URL("..", import.meta.url)));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const filesystem = (value) => ({ ...fs, ...value });

export class PhoneError extends Error {
  constructor(code, message, next = []) {
    super(message || code);
    this.code = code;
    this.next = next;
  }
}
export async function readJSON(file, fallback, options = {}) {
  try {
    return JSON.parse(await filesystem(options.fsAPI).readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
// Resolve existing ancestors, including junctions, even when the final directory is new.
export async function canonicalPath(value, options = {}) {
  const io = filesystem(options.fsAPI);
  let current = resolve(value);
  const tail = [];
  while (true) {
    try {
      return resolve(await io.realpath(current), ...tail.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}
export function pathKey(value, platform = process.platform) {
  const normalized =
    resolve(value).replace(/[\\/]+$/, "") || parse(resolve(value)).root;
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
export function pathIsWithin(value, parent, platform = process.platform) {
  const childKey = pathKey(value, platform),
    parentKey = pathKey(parent, platform);
  return childKey === parentKey || childKey.startsWith(parentKey + sep);
}
export async function assertPrivateStateDirectory(value, options = {}) {
  const candidate = await canonicalPath(value, options),
    home = await canonicalPath(options.homeDirectory || homedir(), options);
  if (
    pathKey(candidate) === pathKey(parse(candidate).root) ||
    pathKey(candidate) === pathKey(home)
  )
    throw new PhoneError(
      "unsafe_state_directory",
      "The home directory and drive/share root cannot be used as state.",
    );
  for (const checkout of options.checkoutRoots || [defaultCheckout]) {
    if (pathIsWithin(candidate, await canonicalPath(checkout, options)))
      throw new PhoneError(
        "unsafe_state_directory",
        "Use a dedicated private directory outside the checkout, including directory aliases.",
      );
  }
  return candidate;
}
export async function saveJSON(file, value, options = {}) {
  const io = filesystem(options.fsAPI),
    sleep = options.sleep || delay;
  await io.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await io.writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await io.rename(temp, file);
        return;
      } catch (error) {
        if (
          !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
          attempt + 1 >= (options.attempts || 6)
        )
          throw error;
        await sleep(Math.min(25 * 2 ** attempt, 400));
      }
    }
  } finally {
    await io.unlink(temp).catch(() => {});
  }
}
export async function withFileLock(file, action, options = {}) {
  const io = filesystem(options.fsAPI),
    sleep = options.sleep || delay;
  const started = Date.now(),
    timeoutMs = options.timeoutMs || 30000,
    token = randomUUID();
  let lease;
  await io.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  while (!lease) {
    try {
      lease = await io.open(file, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readJSON(file, null, { fsAPI: io }).catch(() => null);
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (failure) {
          if (failure.code === "ESRCH") alive = false;
        }
        if (!alive) {
          const latest = await readJSON(file, null, { fsAPI: io }).catch(
            () => null,
          );
          if (latest?.token === owner.token)
            await io.unlink(file).catch((failure) => {
              if (failure.code !== "ENOENT") throw failure;
            });
          continue;
        }
      }
      if (Date.now() - started >= timeoutMs)
        throw new PhoneError(
          "state_busy",
          "Another installation operation still owns this state.",
          [
            "Wait for the current operation, then retry; do not delete a live lock.",
          ],
        );
      await sleep(40);
    }
  }
  try {
    await lease.writeFile(
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
    );
    return await action();
  } finally {
    await lease.close();
    const owner = await readJSON(file, null, { fsAPI: io }).catch(() => null);
    if (owner?.token === token)
      await io.unlink(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}
async function protectDirectory(dir) {
  if (process.platform !== "win32") return fs.chmod(dir, 0o700);
  const sid = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  execFileSync(
    "icacls.exe",
    [
      dir,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
    ],
    { stdio: "pipe", windowsHide: true },
  );
}
export async function setupState(value = stateRoot(), options = {}) {
  const io = filesystem(options.fsAPI),
    dir = await assertPrivateStateDirectory(value, options);
  await io.mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivateStateDirectory(dir, options);
  return withFileLock(
    join(dir, "initialization.lock"),
    async () => {
      const file = join(dir, "config.json");
      let config = await readJSON(file, null, { fsAPI: io });
      if (
        config &&
        (config.application !== "codex-phone" || config.schema !== 1)
      )
        throw new PhoneError(
          "state_ownership_invalid",
          "This directory does not contain a supported codex-phone state.",
        );
      await (options.protectDirectory || protectDirectory)(dir);
      if (!config) {
        config = {
          application: "codex-phone",
          schema: 1,
          deviceId: randomUUID(),
          deviceName: hostname(),
          adminSecret: secret(),
          agentSecret: secret(),
          ports: { gateway: 0, control: 0, desktop: 0 },
          relay: { provider: "provided", endpoint: "" },
          proxy: "",
          desktopPath: "",
        };
        await saveJSON(file, config, { fsAPI: io, sleep: options.sleep });
      }
      return config;
    },
    { fsAPI: io, timeoutMs: options.lockTimeoutMs, sleep: options.sleep },
  );
}
export function httpsOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new PhoneError(
      "https_origin_required",
      "Provide a complete HTTPS origin without a path, credentials or query.",
    );
  return url.origin;
}

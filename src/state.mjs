import { randomBytes, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
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
export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export async function saveJSON(file, value) {
  await mkdir(resolve(file, ".."), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export async function setupState(dir = stateRoot()) {
  const path = join(dir, "config.json");
  let config = await readJSON(path, null);
  if (config && (config.application !== "codex-phone" || config.schema !== 1))
    throw new PhoneError(
      "state_ownership_invalid",
      "This directory does not contain a supported codex-phone state.",
    );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
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
  } else await chmod(dir, 0o700);
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
    await saveJSON(path, config);
  }
  return config;
}
export function httpsOrigin(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error("HTTPS_ORIGIN_REQUIRED");
  return u.origin;
}
export class PhoneError extends Error {
  constructor(code, message, next = []) {
    super(message || code);
    this.code = code;
    this.next = next;
  }
}

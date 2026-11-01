import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { PhoneError } from "./state.mjs";
import { readActiveInstallation } from "../scripts/install-pointer.mjs";
const exec = promisify(execFile);
export async function powershell(script, args = []) {
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script,
      ...args,
    ],
    { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim();
}
export const officialPath = (p) =>
  typeof p === "string" &&
  /[\\/]WindowsApps[\\/]OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0[\\/]app[\\/]ChatGPT\.exe$/i.test(
    p,
  );
export function selectDesktop({ running, installed }) {
  const valid = running.filter((p) => officialPath(p.path));
  return {
    running: valid,
    launchPath: installed.find(officialPath) || valid[0]?.path || null,
  };
}
export async function inventory() {
  if (process.platform !== "win32")
    throw new PhoneError(
      "unsupported_platform",
      "Windows Desktop is required.",
    );
  const raw = await powershell(
    `$ErrorActionPreference='Stop';$r=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | ForEach-Object {@{pid=$_.ProcessId;path=$_.ExecutablePath;commandLine=$_.CommandLine}});$i=@(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | ForEach-Object {Join-Path $_.InstallLocation 'app\\ChatGPT.exe'});@{running=$r;installed=$i}|ConvertTo-Json -Depth 5 -Compress`,
  );
  return selectDesktop(JSON.parse(raw));
}
export async function portOwner(port) {
  if (!port) return null;
  return JSON.parse(
    await powershell(
      `$items=@(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | ForEach-Object {$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess);@{pid=$p.ProcessId;path=$p.ExecutablePath;address=$_.LocalAddress}});ConvertTo-Json -InputObject $items -Compress`,
    ),
  );
}
export async function verifyDesktopPort(port) {
  const owners = await portOwner(port);
  const owner = owners?.[0];
  if (
    !owner ||
    !owners.every(
      (item) =>
        officialPath(item.path) &&
        item.pid === owner.pid &&
        ["127.0.0.1", "::1"].includes(item.address),
    )
  )
    throw new PhoneError(
      "desktop_port_owner_invalid",
      "Desktop debug port must belong to an official loopback-only Desktop instance.",
      ["Run doctor; do not kill another process."],
    );
  return owner;
}
export async function freePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(preferred, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}
export async function ensureDesktop(
  config,
  { signal, checkCancelled = async () => {} } = {},
) {
  signal?.throwIfAborted();
  await checkCancelled();
  const data = await inventory();
  signal?.throwIfAborted();
  await checkCancelled();
  for (const p of data.running) {
    const match = /--remote-debugging-port[= ](\d+)/.exec(p.commandLine || "");
    if (match) {
      const port = Number(match[1]);
      await verifyDesktopPort(port);
      signal?.throwIfAborted();
      config.ports.desktop = port;
      return { ok: true, reused: true, port, path: p.path };
    }
  }
  if (data.running.length)
    return {
      ok: false,
      code: "desktop_normal_exit_required",
      next: [
        "Normally exit Codex, including the tray icon. The companion will reopen it. Do not force-close it.",
      ],
    };
  const path = config.desktopPath || data.launchPath;
  if (!path || !officialPath(path))
    return {
      ok: false,
      code: "desktop_not_installed",
      next: ["Install and log in to the official Codex Desktop app."],
    };
  let port;
  try {
    port = await freePort(config.ports.desktop);
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    port = await freePort();
  }
  config.ports.desktop = port;
  signal?.throwIfAborted();
  await checkCancelled();
  // Desktop is intentionally visible because this action opens the user's interactive app.
  const child = spawn(
    path,
    [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    { detached: true, stdio: "ignore", windowsHide: false },
  );
  child.on("error", () => {});
  child.unref();
  return { ok: true, launched: true, port, path };
}
export async function createShortcuts(root, dir) {
  if (process.platform !== "win32") return;
  const active = await readActiveInstallation(dir, { fallbackRoot: root });
  root = active.pointer?.bootstrapRoot || root;
  const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference='Stop';$shell=New-Object -ComObject WScript.Shell;$folder=Join-Path ([Environment]::GetFolderPath('Programs')) 'codex-phone';[IO.Directory]::CreateDirectory($folder)|Out-Null;foreach($entry in @(@('Codex Phone','start'),@('Codex Phone Pair','pair'))){$file=Join-Path $folder ($entry[0]+'.lnk');$exists=Test-Path -LiteralPath $file;$s=$shell.CreateShortcut($file);if($exists -and $s.Description -ne 'codex-phone managed companion'){throw 'SHORTCUT_OWNERSHIP_CONFLICT'};$s.TargetPath='wscript.exe';$s.Arguments='"'+${quote(root + "\\scripts\\launch.vbs")}+'" "'+${quote(root)}+'" "'+${quote(dir)}+'" '+$entry[1]+' "'+${quote(process.execPath)}+'"';$s.Description='codex-phone managed companion';$s.Save()}`;
  await powershell(script);
}

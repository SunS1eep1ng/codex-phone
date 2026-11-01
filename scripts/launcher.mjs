import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readActiveInstallation } from "./install-pointer.mjs";
const bootstrap = resolve(
    process.argv[2] || fileURLToPath(new URL("..", import.meta.url)),
  ),
  dir = process.argv[3],
  action = process.argv[4];
if (!dir || !["start", "pair"].includes(action))
  throw Error(
    "Launcher requires a private state directory and start/pair action.",
  );
try {
  const active = await readActiveInstallation(dir, { fallbackRoot: bootstrap });
  const args = [
    join(active.root, "dist/cli.mjs"),
    "--state",
    dir,
    action,
    "--open",
    ...(action === "start" ? ["--supervise"] : []),
  ];
  const code = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, CODEX_PHONE_STATE: dir },
    });
    p.once("error", reject);
    p.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} catch (e) {
  console.error(e.code || e.message);
  process.exitCode = 1;
}

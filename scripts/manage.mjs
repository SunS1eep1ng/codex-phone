import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readActiveInstallation } from "./install-pointer.mjs";
import { stateRoot, assertPrivateStateDirectory } from "../src/state.mjs";
const bootstrap = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2),
  index = args.indexOf("--state");
try {
  if (index >= 0 && !args[index + 1])
    throw Error("--state requires a directory");
  const dir = await assertPrivateStateDirectory(
    index >= 0 ? args[index + 1] : stateRoot(),
    { checkoutRoots: [bootstrap] },
  );
  const active = await readActiveInstallation(dir, { fallbackRoot: bootstrap });
  process.exitCode = await new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [join(active.root, "dist/cli.mjs"), ...(args.length ? args : ["--help"])],
      {
        stdio: "inherit",
        windowsHide: true,
        env: { ...process.env, CODEX_PHONE_STATE: dir },
      },
    );
    p.once("error", reject);
    p.once("close", (code) => resolve(code ?? 1));
  });
} catch (e) {
  const print = args.includes("--json") ? console.log : console.error;
  print(
    JSON.stringify({
      status: "error",
      ok: false,
      code: e.code || "management_entry_failed",
      message: e.message,
      next: e.next || [],
    }),
  );
  process.exitCode = 1;
}

import { spawn } from "node:child_process";
import { join } from "node:path";
import { supervise } from "../src/supervisor.mjs";
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const dir = value("--state"),
  root = value("--root");
if (!dir || !root) throw Error("Explicit --state and --root are required.");
try {
  await supervise({
    dir,
    root,
    launch: async (root, stateDir, stopped) => {
      if (await stopped()) return;
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [join(root, "dist/cli.mjs"), "--state", stateDir, "start", "--json"],
          {
            stdio: "ignore",
            windowsHide: true,
            env: {
              ...process.env,
              CODEX_PHONE_STATE: stateDir,
              CODEX_PHONE_SUPERVISOR_START: "1",
            },
          },
        );
        const monitor = setInterval(
          () =>
            void stopped()
              .then((stop) => {
                if (stop) child.kill();
              })
              .catch(() => {}),
          200,
        );
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("RECOVERY_START_TIMEOUT"));
        }, 45000);
        const clear = () => {
          clearTimeout(timer);
          clearInterval(monitor);
        };
        child.once("error", (e) => {
          clear();
          reject(e);
        });
        child.once("close", (code) => {
          clear();
          code === 0 ? resolve() : reject(Error("RECOVERY_START_EXIT_" + code));
        });
      });
    },
  });
} catch (e) {
  console.error(e.code || e.message);
  process.exitCode = 1;
}

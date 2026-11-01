import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { stateRoot } from "../src/state.mjs";
import { performInstall } from "./install-transaction.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const stateIndex = args.indexOf("--state");
try {
  if (args.includes("--help")) {
    console.log(
      "Usage: node scripts/install.mjs [--upgrade] [--state DIRECTORY] [--no-shortcuts]",
    );
  } else {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 24 || (major === 24 && minor < 16))
      throw Error("Node >=24.16.0 required");
    if (stateIndex >= 0 && !args[stateIndex + 1])
      throw Error("--state requires a directory");
    const npmCLI = join(
      dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    );
    await access(npmCLI).catch(() => {
      throw Error("Install a standard Node distribution containing npm.");
    });
    const result = await performInstall({
      sourceRoot: root,
      stateDir: resolve(stateIndex >= 0 ? args[stateIndex + 1] : stateRoot()),
      upgrade: args.includes("--upgrade"),
      noShortcuts: args.includes("--no-shortcuts"),
      npmCLI,
    });
    console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: "error",
        ok: false,
        code: error.code || "installation_failed",
        message: error.message,
        next: error.next || [],
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

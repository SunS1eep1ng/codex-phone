import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const major = Number(process.versions.node.split(".")[0]);
if (
  major < 24 ||
  (major === 24 && Number(process.versions.node.split(".")[1]) < 16)
)
  throw Error("Node >=24.16.0 required");
const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
if (!existsSync(npm))
  throw Error(
    "Install a standard Node distribution containing npm, then run npm ci and npm run build manually.",
  );
const run = (args) =>
  execFileSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
const upgrade = process.argv.includes("--upgrade");
if (upgrade && existsSync(join(root, "dist/cli.mjs")))
  run([join(root, "dist/cli.mjs"), "stop"]);
run([npm, "ci", "--no-audit", "--no-fund"]);
run([npm, "run", "build"]);
run([join(root, "dist/cli.mjs"), "setup"]);
if (upgrade) run([join(root, "dist/cli.mjs"), "start"]);

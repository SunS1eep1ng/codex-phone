import { readFile, mkdir, cp, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
execFileSync(process.execPath, ["scripts/audit-publish.mjs"], {
  cwd: root,
  stdio: "inherit",
});
const stage = join(root, "build/distribution");
if (
  !stage.startsWith(join(root, "build") + "/") &&
  !stage.startsWith(join(root, "build") + "\\")
)
  throw Error("UNSAFE_RELEASE_STAGE");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const files = JSON.parse(
  await readFile(join(root, "public-files.json"), "utf8"),
).files;
for (const file of files) {
  await mkdir(join(stage, file, ".."), { recursive: true });
  await cp(join(root, file), join(stage, file));
}
await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
// The archive includes source and built UI, never node_modules, state or the signing key.
await mkdir(join(root, "release"), { recursive: true });
const archive = join(root, `release/codex-phone-v${version}-windows.zip`);
execFileSync("tar", ["-a", "-cf", archive, "-C", stage, "."], {
  stdio: "inherit",
});
const artifacts = [
  `codex-phone-v${version}.apk`,
  `codex-phone-v${version}-windows.zip`,
];
const sums = [];
for (const file of artifacts)
  sums.push(
    createHash("sha256")
      .update(await readFile(join(root, "release", file)))
      .digest("hex") +
      "  " +
      file,
  );
await writeFile(join(root, "release/SHA256SUMS"), sums.join("\n") + "\n");
console.log("Release whitelist archive and SHA256SUMS prepared.");

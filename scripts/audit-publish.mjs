import { readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(
  await readFile(join(root, "public-files.json"), "utf8"),
).files;
const allowed = new Set(manifest);
if (allowed.size !== manifest.length) throw Error("DUPLICATE_MANIFEST_PATH");
let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\0")
    .filter(Boolean);
} catch {}
for (const path of tracked)
  if (!allowed.has(path)) throw Error("NON_WHITELISTED_TRACKED_FILE: " + path);
const forbidden = [
  [/C:[\\/]Users[\\/](?!EXAMPLE|YOUR_USER)/i, "personal absolute path"],
  [
    /https?:\/\/codex-phone-[a-f0-9]{8}\.[a-z0-9.-]+\.workers\.dev|127\.0\.0\.1:\d{2,5}/,
    "deployment endpoint or fixed proxy",
  ],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/\b(?:sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/, "account token"],
];
for (const path of manifest) {
  if (
    path.startsWith("/") ||
    path.split("/").includes("..") ||
    /\.(?:apk|p12|jks|pfx|pass|log)$/.test(path) ||
    /(^|\/)(?:\.cache|state|runtime|node_modules|dist|build)\//.test(path)
  )
    throw Error("UNSAFE_MANIFEST_PATH: " + path);
  const file = join(root, path);
  const info = await stat(file);
  if (!info.isFile() || info.size > 2 * 1024 * 1024)
    throw Error("UNEXPECTED_PUBLIC_FILE: " + path);
  const content = await readFile(file, "utf8");
  if (path === "scripts/audit-publish.mjs") continue;
  for (const [pattern, label] of forbidden)
    if (pattern.test(content)) throw Error(label + ": " + path);
}
const strings = await readFile(
  join(root, "android/res/values/strings.xml"),
  "utf8",
);
if (!/<string name="default_gateway"><\/string>/.test(strings))
  throw Error("APK_GATEWAY_MUST_BE_BLANK");
console.log(
  JSON.stringify({
    ok: true,
    whitelistedFiles: manifest.length,
    trackedFiles: tracked.length,
    privateStateExcluded: true,
  }),
);

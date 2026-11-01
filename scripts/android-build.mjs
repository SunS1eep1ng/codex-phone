import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sdk =
  option("--sdk") || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
const jdk = option("--jdk") || process.env.JAVA_HOME;
const tools = option("--tools") || (sdk && join(sdk, "build-tools", "35.0.0"));
const platform =
  option("--platform") ||
  (sdk && join(sdk, "platforms", "android-35", "android.jar"));
if (!jdk || !tools || !platform)
  throw Error(
    "Set JAVA_HOME and ANDROID_SDK_ROOT (platform 35, build-tools 35.0.0), or pass --jdk --tools --platform.",
  );
const debug = args.includes("--debug");
const destination = join(root, "build/android" + (debug ? "-dev" : ""));
if (!destination.startsWith(root + sep)) throw Error("UNSAFE_BUILD_PATH");
await mkdir(destination, { recursive: true });
for (const name of ["gen", "classes", "dex"]) {
  const path = join(destination, name);
  await rm(path, { recursive: true, force: true });
  await mkdir(path);
}
const exe = (name) => (process.platform === "win32" ? name + ".exe" : name);
const java = join(jdk, "bin", exe("java"));
const run = (p, values) =>
  execFileSync(p, values, {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, JAVA_HOME: jdk },
  });
const source = join(destination, "MainActivity.java");
let code = await readFile(
  join(root, "android/src/io/github/suns1eep1ng/codexphone/MainActivity.java"),
  "utf8",
);
let manifest = await readFile(
  join(root, "android/AndroidManifest.xml"),
  "utf8",
);
if (debug) {
  code = code
    .replaceAll(
      "io.github.suns1eep1ng.codexphone",
      "io.github.suns1eep1ng.codexphone.dev",
    )
    .replaceAll("codexphone-public", "codexphone-public-dev");
  manifest = manifest
    .replaceAll(
      "io.github.suns1eep1ng.codexphone",
      "io.github.suns1eep1ng.codexphone.dev",
    )
    .replaceAll("codexphone-public", "codexphone-public-dev")
    .replace('android:label="Codex Phone"', 'android:label="Codex Phone Dev"');
}
await writeFile(source, code);
await writeFile(join(destination, "AndroidManifest.xml"), manifest);
const resources = join(destination, "resources.zip"),
  unsigned = join(destination, "unsigned.apk");
run(join(tools, exe("aapt2")), [
  "compile",
  "--dir",
  join(root, "android/res"),
  "-o",
  resources,
]);
run(join(tools, exe("aapt2")), [
  "link",
  "-o",
  unsigned,
  "-I",
  platform,
  "--manifest",
  join(destination, "AndroidManifest.xml"),
  "-R",
  resources,
  "--java",
  join(destination, "gen"),
  "--auto-add-overlay",
]);
async function files(dir, ext) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path, ext)));
    else if (path.endsWith(ext)) result.push(path);
  }
  return result;
}
run(join(jdk, "bin", exe("javac")), [
  "-encoding",
  "UTF-8",
  "-source",
  "8",
  "-target",
  "8",
  "-classpath",
  platform,
  "-d",
  join(destination, "classes"),
  source,
  ...(await files(join(destination, "gen"), ".java")),
]);
run(java, [
  "-cp",
  join(tools, "lib/d8.jar"),
  "com.android.tools.r8.D8",
  "--lib",
  platform,
  "--min-api",
  "26",
  "--output",
  join(destination, "dex"),
  ...(await files(join(destination, "classes"), ".class")),
]);
run(join(jdk, "bin", exe("jar")), [
  "uf",
  unsigned,
  "-C",
  join(destination, "dex"),
  "classes.dex",
]);
await mkdir(join(root, "release"), { recursive: true });
const out = join(
  root,
  "release",
  `codex-phone-v${version}${debug ? "-dev" : ""}-unsigned.apk`,
);
run(join(tools, exe("zipalign")), ["-p", "-f", "4", unsigned, out]);
console.log("Unsigned APK: " + out);

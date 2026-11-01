import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jdk = process.env.JAVA_HOME;
const tools =
  process.env.CODEX_PHONE_ANDROID_TOOLS ||
  join(
    process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || "",
    "build-tools/35.0.0",
  );
const keyDir = process.env.CODEX_PHONE_SIGNING_DIR;
if (!jdk || !keyDir)
  throw Error(
    "Set JAVA_HOME, ANDROID_SDK_ROOT (or CODEX_PHONE_ANDROID_TOOLS), and CODEX_PHONE_SIGNING_DIR outside this repository.",
  );
const dir = resolve(keyDir);
if (dir === root || dir.startsWith(root + "\\") || dir.startsWith(root + "/"))
  throw Error("SIGNING_KEY_MUST_BE_OUTSIDE_REPOSITORY");
await mkdir(dir, { recursive: true, mode: 0o700 });
const key = join(dir, "codex-phone-release.p12"),
  pass = join(dir, "codex-phone-release.pass");
const exists = async (p) =>
  access(p).then(
    () => true,
    () => false,
  );
const exe = (n) =>
  join(jdk, "bin", n + (process.platform === "win32" ? ".exe" : ""));
const run = (p, a) =>
  execFileSync(p, a, { stdio: "inherit", windowsHide: true });
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
}
if (!(await exists(key))) {
  if (!(await exists(pass)))
    await writeFile(pass, randomBytes(32).toString("base64url"), {
      mode: 0o600,
    });
  run(exe("keytool"), [
    "-genkeypair",
    "-keystore",
    key,
    "-storetype",
    "PKCS12",
    "-storepass:file",
    pass,
    "-alias",
    "codex-phone",
    "-keyalg",
    "RSA",
    "-keysize",
    "3072",
    "-validity",
    "10000",
    "-dname",
    "CN=codex-phone, OU=Open Source",
    "-noprompt",
  ]);
}
const debug = process.argv.includes("--debug");
const base = `codex-phone-v0.1.0${debug ? "-dev" : ""}`;
const input = join(root, "release", base + "-unsigned.apk"),
  output = join(root, "release", base + ".apk");
run(exe("java"), [
  "-jar",
  join(tools, "lib/apksigner.jar"),
  "sign",
  "--ks",
  key,
  "--ks-pass",
  "file:" + pass,
  "--ks-key-alias",
  "codex-phone",
  "--out",
  output,
  input,
]);
run(exe("java"), [
  "-jar",
  join(tools, "lib/apksigner.jar"),
  "verify",
  "--verbose",
  "--print-certs",
  output,
]);
const hash = createHash("sha256")
  .update(await readFile(output))
  .digest("hex");
await writeFile(
  join(root, "release", base + ".sha256"),
  hash + "  " + base + ".apk\n",
);
console.log("Signed and verified " + base + ".apk");

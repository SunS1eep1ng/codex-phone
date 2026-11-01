import {
  mkdir,
  readFile,
  writeFile,
  cp,
  access,
  unlink,
  rename,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const lock = JSON.parse(
  await readFile(join(root, "upstream.lock.json"), "utf8"),
);
export async function downloadVerified(asset, destination, { signal } = {}) {
  signal?.throwIfAborted();
  await mkdir(resolve(destination, ".."), { recursive: true });
  let bytes;
  try {
    bytes = await readFile(destination);
  } catch {}
  if (
    !bytes ||
    createHash("sha256").update(bytes).digest("hex") !== asset.sha256
  ) {
    const temporary = destination + "." + randomUUID() + ".download";
    try {
      // curl honors process-local HTTPS_PROXY, supports redirects, and fails on HTTP errors.
      await promisify(execFile)(
        process.platform === "win32" ? "curl.exe" : "curl",
        [
          "-fL",
          "--retry",
          "3",
          "--connect-timeout",
          "20",
          "--max-time",
          "600",
          "-o",
          temporary,
          asset.url,
        ],
        {
          windowsHide: true,
          timeout: 650000,
          maxBuffer: 2 * 1024 * 1024,
          signal,
        },
      );
      bytes = await readFile(temporary);
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
        throw Error("CHECKSUM_MISMATCH: " + asset.url);
      signal?.throwIfAborted();
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
  signal?.throwIfAborted();
  return destination;
}
export async function prepare() {
  const cache = join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const source = await downloadVerified(
    lock.upstream.source,
    join(cache, "source.tar.gz"),
  );
  const web = await downloadVerified(lock.upstream.web, join(cache, "web.zip"));
  const sourceDir = join(cache, "source");
  const webDir = join(cache, "web");
  // Verify archive paths before extraction, including absolute and parent paths.
  for (const archive of [source, web]) {
    const entries = execFileSync("tar", ["-tf", archive], {
      encoding: "utf8",
    }).split(/\r?\n/);
    if (
      entries.some(
        (p) =>
          p.startsWith("/") ||
          /^[A-Za-z]:/.test(p) ||
          p.split(/[\\/]/).includes(".."),
      )
    )
      throw Error("UNSAFE_ARCHIVE");
  }
  await mkdir(sourceDir, { recursive: true });
  await mkdir(webDir, { recursive: true });
  execFileSync("tar", ["-xf", source, "-C", sourceDir]);
  execFileSync("tar", ["-xf", web, "-C", webDir]);
  return { sourceDir, webDir };
}
if (
  basename(fileURLToPath(import.meta.url)) === "prepare-upstream.mjs" &&
  process.argv[1] === fileURLToPath(import.meta.url)
)
  await prepare();

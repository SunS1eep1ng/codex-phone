// Protocol-compatible Node implementation; see upstream local_ops.rs (MIT).
import { stat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
async function directory(path) {
  if (!isAbsolute(path || "") || !(await stat(path)).isDirectory())
    throw Error("ABSOLUTE_DIRECTORY_REQUIRED");
  return path;
}
async function git(cwd, args) {
  return (
    await exec("git", ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout.trim();
}
export async function localOperation(method, p = {}) {
  if (method === "codex-web/local/project-root-suggestion") {
    const base = await directory(p.basePath);
    for (let i = 1; i < 100000; i++) {
      const name = `New Project (${i})`;
      try {
        await stat(join(base, name));
      } catch (e) {
        if (e.code === "ENOENT") return { name, path: join(base, name) };
        throw e;
      }
    }
    throw Error("NO_AVAILABLE_NAME");
  }
  if (method === "codex-web/local/read-image-file") {
    if (!isAbsolute(p.path || "")) throw Error("ABSOLUTE_IMAGE_REQUIRED");
    const s = await stat(p.path);
    if (!s.isFile() || s.size < 1 || s.size > 8 * 1024 * 1024)
      throw Error("IMAGE_SIZE_INVALID");
    const b = await readFile(p.path);
    let contentType;
    if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      contentType = "image/png";
    else if (b[0] === 255 && b[1] === 216 && b[2] === 255)
      contentType = "image/jpeg";
    else if (/^GIF8[79]a/.test(b.toString("ascii", 0, 6)))
      contentType = "image/gif";
    else if (
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP"
    )
      contentType = "image/webp";
    if (!contentType) throw Error("UNSUPPORTED_IMAGE");
    return { data: b.toString("base64"), contentType, size: b.length };
  }
  if (
    [
      "codex-web/local/git-branches",
      "codex-web/local/worktree-branches",
    ].includes(method)
  ) {
    const cwd = await directory(p.cwd || p.sourceCwd);
    let refs;
    try {
      refs = await git(cwd, [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ]);
    } catch {
      return method.endsWith("git-branches")
        ? { currentBranch: null, options: [] }
        : [];
    }
    const options = [
      ...new Set(
        refs
          .split("\n")
          .filter(Boolean)
          .filter((r) => r !== "origin/HEAD"),
      ),
    ].map((value) => ({ value, label: value }));
    return method.endsWith("git-branches")
      ? { currentBranch: await git(cwd, ["branch", "--show-current"]), options }
      : options;
  }
  throw Error("UNSUPPORTED_LOCAL_OPERATION");
}

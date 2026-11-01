import { build } from "esbuild";
import {
  mkdir,
  cp,
  readdir,
  access,
  readFile,
  writeFile,
} from "node:fs/promises";
import { parse, serialize, defaultTreeAdapter } from "parse5";
import { join } from "node:path";
import { root, prepare } from "./prepare-upstream.mjs";
const { sourceDir, webDir } = await prepare();
async function find(dir, name) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, item.name);
    if (item.name === name) return p;
    if (item.isDirectory()) {
      const got = await find(p, name);
      if (got) return got;
    }
  }
}
const entry = await find(sourceDir, "httpServer.ts");
if (!entry) throw Error("UPSTREAM_LAYOUT_CHANGED");
const index = await find(webDir, "index.html");
if (!index) throw Error("UPSTREAM_WEB_MISSING");
await mkdir(join(root, "dist/upstream/dist-cli"), { recursive: true });
await cp(join(index, ".."), join(root, "dist/upstream/dist"), {
  recursive: true,
});
// Compose the licensed HTML document with an owned recovery script. No upstream
// JavaScript/server bundle or official Desktop files are patched.
const document = parse(await readFile(index, "utf8"));
const html = document.childNodes.find((node) => node.tagName === "html");
const head = html?.childNodes.find((node) => node.tagName === "head");
if (!head) throw Error("UPSTREAM_HTML_HEAD_MISSING");
const recovery = defaultTreeAdapter.createElement(
  "script",
  "http://www.w3.org/1999/xhtml",
  [
    { name: "src", value: "/phone-recovery.js" },
    { name: "defer", value: "" },
  ],
);
if (head.childNodes.length)
  defaultTreeAdapter.insertBefore(head, recovery, head.childNodes[0]);
else defaultTreeAdapter.appendChild(head, recovery);
await writeFile(
  join(root, "dist/upstream/dist/index.html"),
  serialize(document),
);
await build({
  entryPoints: [join(root, "src/browser-recovery.mjs")],
  outfile: join(root, "dist/upstream/dist/phone-recovery.js"),
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
});
await build({
  entryPoints: [join(root, "src/service-worker.mjs")],
  outfile: join(root, "dist/upstream/dist/sw.js"),
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
});
await build({
  entryPoints: [entry],
  outfile: join(root, "dist/upstream/dist-cli/server.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  nodePaths: [join(root, "node_modules")],
  sourcemap: false,
});
await build({
  entryPoints: [join(root, "src/cli.mjs")],
  outfile: join(root, "dist/cli.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
});
await cp(join(root, "LICENSE"), join(root, "dist/LICENSE"));
await cp(
  join(root, "THIRD_PARTY_NOTICES.md"),
  join(root, "dist/THIRD_PARTY_NOTICES.md"),
);
console.log("Built pinned upstream library, static UI and codex-phone CLI.");

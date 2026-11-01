import { build } from "esbuild";
import { mkdir, cp, readdir, access } from "node:fs/promises";
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

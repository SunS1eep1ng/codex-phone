import test from "node:test";
import assert from "node:assert/strict";
import { selectDesktop, officialPath, freePort } from "../src/windows.mjs";
import { runTool } from "../src/relay.mjs";
const old =
  "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
  newer = old.replace("26.1.0", "26.2.0");
test("old running official instance remains valid after Store update", () => {
  const plan = selectDesktop({
    running: [
      { path: old, pid: 1 },
      { path: "C:\\fake\\ChatGPT.exe", pid: 2 },
    ],
    installed: [newer],
  });
  assert.equal(plan.running.length, 1);
  assert.equal(plan.running[0].path, old);
  assert.equal(plan.launchPath, newer);
  assert(!officialPath("C:\\fake\\ChatGPT.exe"));
});
test("occupied ports are rejected, never killed", async () => {
  const net = await import("node:net");
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  await assert.rejects(freePort(s.address().port), { code: "EADDRINUSE" });
  await new Promise((r) => s.close(r));
});
test("child failures retain real exit code; empty output is valid", async () => {
  assert.equal(await runTool(process.execPath, ["-e", ""]), "");
  await assert.rejects(
    runTool(process.execPath, ["-e", "process.exit(7)"]),
    /CHILD_EXIT_7/,
  );
});

// Opt-in, read-only acceptance. Never launches, closes or restarts Desktop.
import { inventory, verifyDesktopPort } from "../src/windows.mjs";
import { NativeDriver } from "../src/native.mjs";
if (!process.argv.includes("--allow-desktop-read"))
  throw Error("Explicit --allow-desktop-read is required.");
const { running } = await inventory();
const processInfo = running.find((p) =>
  /--remote-debugging-port[= ]\d+/.test(p.commandLine || ""),
);
if (!processInfo)
  throw Error(
    "No official Desktop running with loopback CDP. Normally exit/reopen via companion first.",
  );
const port = Number(
  /--remote-debugging-port[= ](\d+)/.exec(processInfo.commandLine)[1],
);
const driver = new NativeDriver({ port, verify: verifyDesktopPort });
try {
  const health = await driver.health();
  let historyRead = false;
  if (health.ok) {
    const list = await driver.rpc("thread/list", {
      limit: 1,
      archived: false,
      sortKey: "updated_at",
      modelProviders: [],
    });
    if (list.data.length) {
      const response = await driver.rpc("thread/read", {
        threadId: list.data[0].id,
        includeTurns: true,
      });
      historyRead = Array.isArray(response?.thread?.turns);
      if (!historyRead) throw Error("NATIVE_HISTORY_INVALID");
    }
  }
  console.log(
    JSON.stringify({
      desktopPathVersion: /OpenAI\.Codex_([^_]+)/.exec(processInfo.path)?.[1],
      ...health,
      historyRead,
    }),
  );
  if (!health.ok) process.exitCode = 1;
} finally {
  await driver.close();
}

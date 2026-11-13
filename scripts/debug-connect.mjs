import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const root = join(import.meta.dirname, "..");
const configDir = mkdtempSync(join(tmpdir(), "gb-ava-debug-"));
const child = spawn(process.execPath, ["bridge/dist/cli.js", "serve", "--port", "0"], {
  cwd: root,
  env: { ...process.env, AVA_BRIDGE_CONFIG_DIR: configDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
let err = "";
child.stdout.on("data", (c) => (out += c.toString()));
child.stderr.on("data", (c) => (err += c.toString()));
await new Promise((r) => setTimeout(r, 1500));
const port = Number(/"port":(\d+)/.exec(out)?.[1]);
const token = readFileSync(join(configDir, "token"), "utf8").trim();
console.log("bridge port", port, "token fp", token.slice(0, 6));

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "gb-ava-prof-")), {
  headless: false,
  args: [
    `--disable-extensions-except=${join(root, "extension/dist")}`,
    `--load-extension=${join(root, "extension/dist")}`,
    "--no-first-run",
  ],
});
let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20000 }));
console.log("sw", worker.url());
worker.on("close", () => console.log("!! service worker closed"));
const id = new URL(worker.url()).host;
const page = await context.newPage();
await page.goto(`chrome-extension://${id}/options.html`);
await page.fill("#bridge-url", `ws://127.0.0.1:${port}`);
await page.fill("#bridge-token", token);
await page.click("button[type=submit]");

for (let i = 0; i < 6; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const status = await page.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ type: "ava.status" });
    return reply;
  });
  console.log(`t+${(i + 1) * 2}s`, JSON.stringify(status?.supervisor), JSON.stringify(status?.health?.lastError));
}
console.log("--- bridge stderr ---\n" + err);
console.log("--- bridge health ---");
console.log(await (await fetch(`http://127.0.0.1:${port}/health`)).text());
await context.close();
child.kill("SIGTERM");

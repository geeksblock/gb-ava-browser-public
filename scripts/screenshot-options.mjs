/**
 * Screenshot the options page in a throwaway profile, for visual review of the
 * only human-facing surface in M0. Not a gate: `npm run screenshot:options`.
 */

import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const root = join(import.meta.dirname, "..");
const configDir = mkdtempSync(join(tmpdir(), "gb-ava-shot-bridge-"));
const bridge = spawn(process.execPath, ["bridge/dist/cli.js", "serve", "--port", "0"], {
  cwd: root,
  env: { ...process.env, AVA_BRIDGE_CONFIG_DIR: configDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
bridge.stdout.on("data", (chunk) => (out += chunk.toString()));
await new Promise((resolve) => setTimeout(resolve, 1200));
const port = Number(/"port":(\d+)/.exec(out)?.[1]);

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "gb-ava-shot-profile-")), {
  headless: false,
  viewport: { width: 980, height: 1180 },
  args: [
    `--disable-extensions-except=${join(root, "extension/dist")}`,
    `--load-extension=${join(root, "extension/dist")}`,
    "--no-first-run",
  ],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
const id = new URL(worker.url()).host;
const page = await context.newPage();
await page.goto(`chrome-extension://${id}/options.html`);
await page.fill("#bridge-url", `ws://127.0.0.1:${port}`);
await page.fill("#bridge-token", "0123456789abcdefghijklmnopqrstuvwxyz-token");
await page.click("button[type=submit]");
await page.waitForTimeout(2500);
const outPath = join(root, "test-results", "options-page.png");
await page.screenshot({ path: outPath, fullPage: true });
process.stdout.write(`options page screenshot: ${outPath}\n`);
await context.close();
bridge.kill("SIGTERM");

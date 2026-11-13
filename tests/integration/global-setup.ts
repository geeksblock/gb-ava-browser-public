import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

/**
 * Build the artefacts under test once, so the loaded extension is the current source.
 *
 * Also warm Chromium once. The first launch on a cold CI runner takes long enough
 * that the suite's first test could miss its connect window (observed: the worker
 * never opened a socket within 75 s), while every later launch was fine. This
 * launches once and throws the profile away, so the cost is paid here instead of
 * inside a test.
 */
export default async function globalSetup(): Promise<void> {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });

  const warmProfile = mkdtempSync(join(tmpdir(), "gb-ava-warm-"));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
  try {
    context = await chromium.launchPersistentContext(warmProfile, {
      headless: false,
      args: [
        `--disable-extensions-except=${join(root, "extension", "dist")}`,
        `--load-extension=${join(root, "extension", "dist")}`,
      ],
    });
    // The worker is the slow part of a cold start; a failure here is not fatal —
    // the tests still get their own chance.
    await context.waitForEvent("serviceworker", { timeout: 120_000 }).catch(() => undefined);
  } finally {
    await context?.close().catch(() => undefined);
  }
}

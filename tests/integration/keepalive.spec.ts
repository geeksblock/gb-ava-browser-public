import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  bridgeHealth,
  configureViaOptionsPage,
  extensionHealth,
  launchExtension,
  repoRoot,
  startBridge,
  waitForConnected,
} from "./helpers.js";

/**
 * M0 acceptance gate, driven entirely through the bridge (issue #3):
 *
 *   idle for five minutes with no commands, then `health` still answers, the
 *   session id is unchanged, and the worker never restarted.
 *
 * Duration is AVA_KEEPALIVE_IDLE_SECONDS (default 300) so a quick local run can
 * use a shorter soak without changing what the full run proves.
 */

const idleSeconds = Number.parseInt(process.env["AVA_KEEPALIVE_IDLE_SECONDS"] ?? "300", 10);
const idleMs = idleSeconds * 1000;

test("M0: worker survives the idle window and health still answers", async () => {
  test.setTimeout(idleMs + 90_000);

  const bridge = await startBridge();
  const extension = await launchExtension();
  try {
    const page = await extension.optionsPage();
    await configureViaOptionsPage(page, bridge.port, bridge.token);
    const connected = await waitForConnected(bridge.port);
    const first = extensionHealth(connected);
    const sessionId = connected.extension.connected ? connected.extension.sessionId : "";
    const workerBefore = first["worker"] as Record<string, unknown>;
    const keepaliveBefore = first["keepalive"] as Record<string, unknown>;

    expect(sessionId.length).toBeGreaterThan(10);
    expect(keepaliveBefore["offscreenDocument"]).toBe(true);
    expect(keepaliveBefore["alarmScheduled"]).toBe(true);

    // Nothing but the extension's own keepalive runs during this window.
    await new Promise((resolve) => setTimeout(resolve, idleMs));

    const after = await bridgeHealth(bridge.port);
    expect(after.extension.connected).toBe(true);
    const second = extensionHealth(after);
    const workerAfter = second["worker"] as Record<string, unknown>;
    const keepaliveAfter = second["keepalive"] as Record<string, unknown>;

    // Same session, no extra worker start: the worker was kept alive, not restarted.
    expect(after.extension.connected && after.extension.sessionId).toBe(sessionId);
    expect(workerAfter["startsThisInstall"]).toBe(workerBefore["startsThisInstall"]);
    expect(workerAfter["phase"]).toBe("connected");
    expect(Number(workerAfter["uptimeMs"])).toBeGreaterThanOrEqual(idleMs - 5_000);

    // The keepalive actually fired rather than the worker merely surviving by luck.
    const ticksBefore = Number(keepaliveBefore["ticksReceived"] ?? 0);
    const ticksAfter = Number(keepaliveAfter["ticksReceived"] ?? 0);
    expect(ticksAfter - ticksBefore).toBeGreaterThanOrEqual(Math.floor(idleMs / 30_000));

    const reconnect = keepaliveAfter["reconnect"] as Record<string, unknown>;
    expect(reconnect["attempts"]).toBe(0);
    expect(keepaliveAfter["offscreenDocument"]).toBe(true);
    expect(bridge.logs()).not.toContain(bridge.token);

    const evidence = {
      measuredAt: new Date().toISOString(),
      idleSeconds,
      sessionIdStable: true,
      workerStartsBefore: workerBefore["startsThisInstall"],
      workerStartsAfter: workerAfter["startsThisInstall"],
      workerUptimeMs: workerAfter["uptimeMs"],
      ticksBefore,
      ticksAfter,
      offscreenDocument: keepaliveAfter["offscreenDocument"],
      alarmScheduled: keepaliveAfter["alarmScheduled"],
    };
    const outDir = join(repoRoot, "test-results");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "m0-keepalive-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`keepalive evidence: ${JSON.stringify(evidence)}\n`);
  } finally {
    await extension.close();
    await bridge.stop();
  }
});

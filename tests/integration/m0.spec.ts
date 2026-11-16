import { expect, test } from "@playwright/test";
import {
  bridgeCall,
  bridgeHealth,
  configureViaOptionsPage,
  extensionHealth,
  launchExtension,
  startBridge,
  waitForConnected,
  type BridgeHandle,
  type ExtensionHandle,
} from "./helpers.js";

/**
 * M0 acceptance: the extension connects to the real bridge, `health`
 * answers from the bridge, the keepalive is armed, the token never appears in a
 * log, and the human-owned `page.evaluate` switch is off until the owner flips it.
 *
 * Everything here is asserted through the bridge's HTTP surface — the test never
 * calls chrome.* or CDP to check the product's behaviour.
 */

let bridge: BridgeHandle;
let extension: ExtensionHandle;

test.beforeEach(async () => {
  bridge = await startBridge();
  extension = await launchExtension();
});

test.afterEach(async () => {
  await extension?.close();
  await bridge?.stop();
});

test("M0: extension connects, health answers from the bridge, keepalive is armed", async () => {
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);

  const health = await waitForConnected(bridge.port);
  const ext = extensionHealth(health);

  expect(health.bridge.protocolVersion).toBe(1);
  expect(health.bridge.tokenConfigured).toBe(true);
  expect(health.extension.connected).toBe(true);
  if (health.extension.connected) {
    expect(health.extension.client.name).toBe("gb-ava-extension");
    expect(health.extension.sessionId.length).toBeGreaterThan(10);
  }

  const worker = ext["worker"] as Record<string, unknown>;
  const keepalive = ext["keepalive"] as Record<string, unknown>;
  const reconnect = keepalive["reconnect"] as Record<string, unknown>;

  expect(worker["phase"]).toBe("connected");
  expect(worker["startsThisInstall"]).toBeGreaterThanOrEqual(1);
  expect(keepalive["offscreenDocument"]).toBe(true);
  expect(keepalive["alarmScheduled"]).toBe(true);
  expect(reconnect["attempts"]).toBe(0);
  expect(ext["lastError"]).toBeNull();

  // page.evaluate ships off (plan §5.1) and the agent may only read that.
  expect(ext["settings"]).toMatchObject({ evaluateEnabled: false, evaluateEnabledBy: "human" });

  // The token is a secret: it must appear in no log line and no health payload.
  expect(bridge.logs()).not.toContain(bridge.token);
  expect(JSON.stringify(health)).not.toContain(bridge.token);

  // The options page polls every five seconds (plus follow-up refreshes after a
  // save), so the badge is allowed one poll to catch up; asserting faster makes
  // this a test of the poll interval rather than of the product.
  await expect(page.locator("#phase-badge")).toHaveText("connected", { timeout: 15_000 });
});

test("M0: the human-owned page.evaluate switch is readable, off by default, and flips without a reconnect", async () => {
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);
  const connected = await waitForConnected(bridge.port);
  const sessionId = connected.extension.connected ? connected.extension.sessionId : "";

  const before = await bridgeCall(bridge.port, bridge.token, "settings.get");
  expect(before.ok).toBe(true);
  expect(before.result).toEqual({ evaluateEnabled: false, evaluateEnabledBy: "human" });

  // A human clicks it; the agent never can.
  await expect(page.locator("#evaluate-enabled")).not.toBeChecked();
  await page.check("#evaluate-enabled");
  await expect(page.locator("#evaluate-note")).toContainText("Currently on");

  const after = await bridgeCall(bridge.port, bridge.token, "settings.get");
  expect(after.result).toEqual({ evaluateEnabled: true, evaluateEnabledBy: "human" });

  const health = await bridgeHealth(bridge.port);
  const ext = extensionHealth(health);
  expect(ext["settings"]).toMatchObject({ evaluateEnabled: true });
  // Same session: the switch takes effect on the next command, no reconnect.
  expect(health.extension.connected && health.extension.sessionId).toBe(sessionId);
});

test("M0: the command surface refuses a caller without the bridge token", async () => {
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);
  await waitForConnected(bridge.port);

  const anonymous = await fetch(`http://127.0.0.1:${bridge.port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "anon", method: "settings.get" }),
  });
  expect(anonymous.status).toBe(401);

  const wrong = await fetch(`http://127.0.0.1:${bridge.port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${"x".repeat(43)}` },
    body: JSON.stringify({ id: "wrong", method: "settings.get" }),
  });
  expect(wrong.status).toBe(401);

  const authorised = await bridgeCall(bridge.port, bridge.token, "settings.get");
  expect(authorised.ok).toBe(true);
});

test("M0: a wrong token blocks instead of hammering, and fixing it connects", async () => {
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, "definitely-not-the-token-0123456789abcd");

  // Blocked, not retrying: the supervisor must not spin on a wrong credential.
  await expect(page.locator("#phase-badge")).toHaveText("blocked", { timeout: 20_000 });
  await page.waitForTimeout(1_500);
  const stillBlocked = await page.locator("#status-phase").textContent();
  expect(stillBlocked).toBe("blocked");

  const disconnected = await bridgeHealth(bridge.port);
  expect(disconnected.extension.connected).toBe(false);

  await configureViaOptionsPage(page, bridge.port, bridge.token);
  await waitForConnected(bridge.port, 20_000);
  expect(bridge.logs()).not.toContain(bridge.token);
});

test("M0: forgetting the token disconnects and returns to unconfigured", async () => {
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);
  await waitForConnected(bridge.port);

  await page.click("#clear");
  await expect(page.locator("#phase-badge")).toHaveText("unconfigured", { timeout: 10_000 });

  await expect
    .poll(async () => (await bridgeHealth(bridge.port)).extension.connected, { timeout: 10_000 })
    .toBe(false);
});

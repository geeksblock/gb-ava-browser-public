import { expect, test } from "@playwright/test";
import {
  bridgeCall,
  configureViaOptionsPage,
  launchExtension,
  startBridge,
  startFixtureSite,
  waitForConnected,
  type BridgeHandle,
  type ExtensionHandle,
  type FixtureSite,
} from "./helpers.js";

/**
 * `tabs.create` (#23).
 *
 * The method exists so a flow that needs a page the user has not opened can stay
 * on the bridge. The guarantee under test is the product's central one: the new tab
 * is created WITHOUT being focused, so Chrome is not raised and the human's
 * attention is untouched. `active: false` on the created tab is the observable
 * form of that promise.
 *
 * Everything is asserted through the bridge's HTTP surface, so a pass proves the
 * product path rather than the harness.
 */

let bridge: BridgeHandle;
let extension: ExtensionHandle;
let site: FixtureSite;

test.beforeEach(async () => {
  bridge = await startBridge();
  site = await startFixtureSite();
  extension = await launchExtension();
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);
  await waitForConnected(bridge.port);
});

test.afterEach(async () => {
  await extension?.close();
  await bridge?.stop();
  await site?.close();
});

interface CreateReply {
  ok: boolean;
  result?: { tabId: number; url: string | null; title: string | null; status: string };
  error?: { code: string; message: string };
}

interface TabRow {
  tabId: number;
  url: string | null;
  title: string | null;
  active: boolean;
}

async function listTabs(): Promise<TabRow[]> {
  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.list", {})) as unknown as {
    ok: boolean;
    result?: { tabs: TabRow[] };
  };
  expect(reply.ok).toBe(true);
  return reply.result?.tabs ?? [];
}

test("CREATE: opens a page nobody has opened before, without focusing it (#23)", async () => {
  const target = site.url("/form");

  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.create", { url: target })) as unknown as CreateReply;

  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  // It answers with the landed tab descriptor, not merely "created".
  expect(reply.result?.tabId).toBeGreaterThanOrEqual(0);
  expect(reply.result?.url).toBe(target);
  expect(reply.result?.status).toBe("complete");

  const rows = await listTabs();
  const created = rows.find((row) => row.tabId === reply.result?.tabId);
  expect(created, "the created tab must be listed").toBeDefined();
  expect(created!.url).toBe(target);
  // The whole point: created but NOT focused.
  expect(created!.active, "a background tab must not become the active tab").toBe(false);
});

test("CREATE: only one tab is active, and it is not the created one", async () => {
  const page = await extension.context.newPage();
  await page.goto(site.url("/"));
  await page.bringToFront();

  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.create", {
    url: site.url("/second"),
  })) as unknown as CreateReply;
  expect(reply.ok).toBe(true);

  const rows = await listTabs();
  const activeRows = rows.filter((row) => row.active);
  expect(activeRows).toHaveLength(1);
  expect(activeRows[0]!.tabId).not.toBe(reply.result?.tabId);
});

test("CREATE: background:false is the explicit opt-in to focus", async () => {
  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.create", {
    url: site.url("/third"),
    background: false,
  })) as unknown as CreateReply;
  expect(reply.ok).toBe(true);

  const rows = await listTabs();
  const created = rows.find((row) => row.tabId === reply.result?.tabId);
  expect(created!.active).toBe(true);
});

test("CREATE: the new tab is fully drivable through the bridge", async () => {
  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.create", {
    url: site.url("/form"),
  })) as unknown as CreateReply;
  expect(reply.ok).toBe(true);
  const tabId = reply.result!.tabId;

  const read = (await bridgeCall(bridge.port, bridge.token, "page.getText", { tabId })) as unknown as {
    ok: boolean;
    result?: { text: string };
    error?: { code: string; message: string };
  };
  // Reading the tab the bridge just opened is what makes the method useful.
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  expect(read.result?.text.length).toBeGreaterThan(0);
});

test("CREATE: a URL a page cannot be is refused, and no tab is opened", async () => {
  const before = await listTabs();

  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.create", {
    url: "javascript:alert(1)",
  })) as unknown as CreateReply;

  expect(reply.ok).toBe(false);
  expect(reply.error?.code).toBe("invalid_request");

  const after = await listTabs();
  expect(after).toHaveLength(before.length);
});

test("CREATE: an unknown parameter is refused rather than ignored", async () => {
  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.create", {
    url: site.url("/"),
    active: true,
  })) as unknown as CreateReply;

  expect(reply.ok).toBe(false);
  expect(reply.error?.code).toBe("invalid_request");
});

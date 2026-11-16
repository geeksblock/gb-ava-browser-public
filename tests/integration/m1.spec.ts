import { expect, test } from "@playwright/test";
import {
  bridgeCall,
  bridgeHealth,
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
 * M1 acceptance: `tabs.*` works against real Chrome, the marker group
 * is red and titled `Ava`, ungrouping leaves no residue, and nothing depends on
 * group membership to control a tab.
 *
 * Everything is asserted through the bridge's HTTP surface — the test never calls
 * chrome.* itself — so a passing test proves the product path, not the harness.
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

interface TabRow {
  tabId: number;
  url: string | null;
  title: string | null;
  active: boolean;
  groupId: number;
}

interface TabsReply {
  ok: boolean;
  result?: { tabs: TabRow[]; count: number };
  error?: { code: string; message: string };
}

interface MarkerView {
  sessionId: string | null;
  tabIds: number[];
  color: string;
  title: string;
  group: { groupId: number; color: string; title: string } | null;
}

async function openTab(path: string): Promise<void> {
  const page = await extension.context.newPage();
  await page.goto(site.url(path));
  await page.bringToFront();
}

async function listTabs(): Promise<TabRow[]> {
  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.list", {})) as unknown as TabsReply;
  expect(reply.ok).toBe(true);
  return reply.result?.tabs ?? [];
}

async function tabIdByUrl(url: string): Promise<number> {
  const tabs = await listTabs();
  const match = tabs.find((tab) => tab.url === url);
  expect(match, `no tab at ${url} in ${JSON.stringify(tabs.map((tab) => tab.url))}`).toBeTruthy();
  return match!.tabId;
}

async function marker(): Promise<MarkerView> {
  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.list", {})) as unknown as {
    ok: boolean;
  };
  expect(reply.ok).toBe(true);
  const health = await bridgeHealth(bridge.port);
  const ext = health.extension;
  expect(ext.connected).toBe(true);
  return (ext.connected ? (ext.health as unknown as { marker: MarkerView }).marker : null) as MarkerView;
}

test("M1: tabs.list and tabs.query address tabs by predicate, never 'the current tab'", async () => {
  await openTab("/alpha");
  await openTab("/beta");

  const tabs = await listTabs();
  expect(tabs.length).toBeGreaterThanOrEqual(2);

  const byTitle = (await bridgeCall(bridge.port, bridge.token, "tabs.query", { titleContains: "fixture-beta" })) as unknown as TabsReply;
  expect(byTitle.ok).toBe(true);
  expect(byTitle.result?.count).toBe(1);
  expect(byTitle.result?.tabs[0]?.title).toBe("fixture-beta");

  const byUrl = (await bridgeCall(bridge.port, bridge.token, "tabs.query", { urlPattern: site.url("/") })) as unknown as TabsReply;
  expect(byUrl.ok).toBe(true);
  expect(byUrl.result?.count).toBeGreaterThanOrEqual(2);

  // A predicate that matches nothing is an empty answer, not an error.
  const none = (await bridgeCall(bridge.port, bridge.token, "tabs.query", { titleContains: "no-such-title" })) as unknown as TabsReply;
  expect(none.ok).toBe(true);
  expect(none.result?.count).toBe(0);

  // Fail closed: a typo in a parameter name is refused, not ignored.
  const typo = (await bridgeCall(bridge.port, bridge.token, "tabs.list", { tabid: 3 })) as unknown as TabsReply;
  expect(typo.ok).toBe(false);
  expect(typo.error?.code).toBe("invalid_request");
});

test("M1: session.start marks the tabs red and 'Ava', asserted from the live tab group", async () => {
  await openTab("/alpha");
  await openTab("/beta");
  const first = await tabIdByUrl(site.url("/alpha"));
  const second = await tabIdByUrl(site.url("/beta"));

  const started = (await bridgeCall(bridge.port, bridge.token, "session.start", { tabIds: [first, second] })) as unknown as {
    ok: boolean;
    result?: { sessionId: string; marker: MarkerView };
    error?: { code: string; message: string };
  };
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  expect(started.result?.sessionId).toBeTruthy();
  expect(started.result?.marker.group?.color).toBe("red");
  expect(started.result?.marker.group?.title).toBe("Ava");

  // The acceptance assertion from plan §4, read from chrome.tabGroups itself via
  // the extension's own health payload (the test never calls chrome.*).
  const live = await marker();
  expect(live.group).not.toBeNull();
  expect(live.group?.color).toBe("red");
  expect(live.group?.title).toBe("Ava");
  expect(live.tabIds.sort()).toEqual([first, second].sort());

  const tabs = await listTabs();
  for (const id of [first, second]) {
    const row = tabs.find((tab) => tab.tabId === id);
    expect(row?.groupId).toBe(live.group?.groupId);
  }
});

test("M1: session.end ungroups and leaves no residue on the tabs", async () => {
  await openTab("/alpha");
  const tabId = await tabIdByUrl(site.url("/alpha"));
  await bridgeCall(bridge.port, bridge.token, "session.start", { tabIds: [tabId] });
  expect((await marker()).group).not.toBeNull();

  const ended = (await bridgeCall(bridge.port, bridge.token, "session.end", {})) as unknown as {
    ok: boolean;
    result?: { ungroupedTabIds: number[]; marker: MarkerView };
  };
  expect(ended.ok).toBe(true);
  expect(ended.result?.ungroupedTabIds).toEqual([tabId]);

  const after = await marker();
  expect(after.group).toBeNull();
  expect(after.sessionId).toBeNull();
  expect(after.tabIds).toEqual([]);

  const rows = await listTabs();
  expect(rows.find((row) => row.tabId === tabId)?.groupId).toBe(-1);
});

test("M1: tabs.navigate drives a background tab without focusing it", async () => {
  await openTab("/alpha");
  await openTab("/beta");
  const target = await tabIdByUrl(site.url("/alpha"));

  const before = await listTabs();
  const activeBefore = before.find((row) => row.active)?.tabId ?? -1;
  expect(activeBefore).not.toBe(target);

  const moved = (await bridgeCall(bridge.port, bridge.token, "tabs.navigate", {
    tabId: target,
    url: site.url("/done"),
  })) as unknown as { ok: boolean; result?: { tabId: number; url: string; title: string }; error?: { code: string; message: string } };
  expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
  expect(moved.result?.tabId).toBe(target);
  // The reply is the tab's own state at the moment the navigation landed.
  expect(moved.result?.url).toBe(site.url("/done"));
  expect(moved.result?.title).toBe("fixture-done");
  // The tab that was in front is still in front: navigating did not steal focus.
  expect((await listTabs()).find((entry) => entry.active)?.tabId).toBe(activeBefore);
});

test("M1: tabs.close removes the tab and the marker keeps the rest", async () => {
  await openTab("/alpha");
  await openTab("/beta");
  const first = await tabIdByUrl(site.url("/alpha"));
  const second = await tabIdByUrl(site.url("/beta"));
  await bridgeCall(bridge.port, bridge.token, "session.start", { tabIds: [first, second] });

  const closed = (await bridgeCall(bridge.port, bridge.token, "tabs.close", { tabId: first })) as unknown as {
    ok: boolean;
    result?: { closedTabId: number; marker: MarkerView };
    error?: { code: string; message: string };
  };
  expect(closed.ok, JSON.stringify(closed.error)).toBe(true);
  expect(closed.result?.closedTabId).toBe(first);

  const rows = await listTabs();
  expect(rows.some((row) => row.tabId === first)).toBe(false);
  expect(closed.result?.marker.tabIds).toEqual([second]);
  expect(closed.result?.marker.group?.color).toBe("red");
});

test("M1: an explicit tabs.group paints one group and keeps its id, and ungroup removes it", async () => {
  await openTab("/alpha");
  await openTab("/beta");
  const first = await tabIdByUrl(site.url("/alpha"));
  const second = await tabIdByUrl(site.url("/beta"));

  const grouped = (await bridgeCall(bridge.port, bridge.token, "tabs.group", { tabIds: [first] })) as unknown as {
    ok: boolean;
    result?: { marker: MarkerView };
    error?: { code: string; message: string };
  };
  expect(grouped.ok, JSON.stringify(grouped.error)).toBe(true);
  const groupId = grouped.result?.marker.group?.groupId;
  expect(groupId).toBeGreaterThanOrEqual(0);
  expect(grouped.result?.marker.color).toBe("red");

  // A second group call must join the same group, not create a rival one: a new
  // group would empty the first, and Chrome deletes an empty group.
  const grown = (await bridgeCall(bridge.port, bridge.token, "tabs.group", { tabIds: [second] })) as unknown as {
    ok: boolean;
    result?: { marker: MarkerView };
  };
  expect(grown.ok).toBe(true);
  expect(grown.result?.marker.group?.groupId).toBe(groupId);
  expect(grown.result?.marker.group?.color).toBe("red");
  expect(grown.result?.marker.group?.title).toBe("Ava");
  expect(grown.result?.marker.tabIds.sort()).toEqual([first, second].sort());

  const released = (await bridgeCall(bridge.port, bridge.token, "tabs.ungroup", { tabIds: [first, second] })) as unknown as {
    ok: boolean;
    result?: { ungroupedTabIds: number[]; marker: MarkerView };
  };
  expect(released.ok).toBe(true);
  expect(released.result?.ungroupedTabIds.sort()).toEqual([first, second].sort());
  expect(released.result?.marker.tabIds).toEqual([]);

  const rows = await listTabs();
  expect(rows.find((row) => row.tabId === first)?.groupId).toBe(-1);
  expect(rows.find((row) => row.tabId === second)?.groupId).toBe(-1);
});

test("M1: if the human dissolves the group, the next touch paints a new one", async () => {
  await openTab("/alpha");
  const tabId = await tabIdByUrl(site.url("/alpha"));
  const started = (await bridgeCall(bridge.port, bridge.token, "session.start", { tabIds: [tabId] })) as unknown as {
    result?: { marker: MarkerView };
  };
  const firstGroup = started.result?.marker.group?.groupId;
  expect(firstGroup).toBeGreaterThanOrEqual(0);

  // The human ungroups it by hand. Doing it from the extension's own page is the
  // same chrome.tabs.ungroup the group's close button performs; our state is not
  // told, exactly as a human action would leave it.
  const page = await extension.optionsPage();
  await page.evaluate((id) => chrome.tabs.ungroup([id]), tabId);
  expect((await listTabs()).find((row) => row.tabId === tabId)?.groupId).toBe(-1);

  // Touching the tab again must paint a new group rather than fail on the dead id.
  const navigated = (await bridgeCall(bridge.port, bridge.token, "tabs.navigate", {
    tabId,
    url: site.url("/done"),
  })) as unknown as { ok: boolean; result?: { marker: MarkerView }; error?: { message: string } };
  expect(navigated.ok, JSON.stringify(navigated.error)).toBe(true);
  const repainted = navigated.result?.marker.group;
  expect(repainted?.color).toBe("red");
  expect(repainted?.title).toBe("Ava");
  expect(repainted?.groupId).not.toBe(firstGroup);
});

test("M1: a bridge restart inside the grace keeps the marker", async () => {
  await openTab("/alpha");
  const tabId = await tabIdByUrl(site.url("/alpha"));
  await bridgeCall(bridge.port, bridge.token, "session.start", { tabIds: [tabId] });
  expect((await marker()).group).not.toBeNull();

  const port = bridge.port;
  const configDir = bridge.configDir;
  await bridge.stop();
  // Well inside the one-minute grace.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  bridge = await startBridge({ port, configDir });
  const reconnected = await waitForConnected(port);

  expect(reconnected.extension.connected).toBe(true);
  const still = await marker();
  expect(still.group?.color).toBe("red");
  expect(still.group?.title).toBe("Ava");
  expect(still.tabIds).toEqual([tabId]);
});

test("M1: past the grace the marker ungroups itself, even with the bridge gone", async () => {
  // The grace is a real minute of chrome.alarms plus a reconnect; this test needs
  // longer than the project default.
  test.setTimeout(240_000);
  await openTab("/alpha");
  const tabId = await tabIdByUrl(site.url("/alpha"));
  await bridgeCall(bridge.port, bridge.token, "session.start", { tabIds: [tabId] });
  expect((await marker()).group).not.toBeNull();

  const port = bridge.port;
  const configDir = bridge.configDir;
  await bridge.stop();
  // The grace is one minute of chrome.alarms: wait past it with the bridge down.
  await new Promise((resolve) => setTimeout(resolve, 100_000));

  bridge = await startBridge({ port, configDir });
  // The reconnect loop backs off to 30 s while the bridge is away, so the first
  // attempt can be a while after it returns.
  await waitForConnected(port, 60_000);

  // The ungroup lands while the bridge is down; poll once it is back to observe it.
  const deadline = Date.now() + 20_000;
  let groupId = (await listTabs()).find((row) => row.tabId === tabId)?.groupId;
  while (groupId !== -1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    groupId = (await listTabs()).find((row) => row.tabId === tabId)?.groupId;
  }
  expect(groupId).toBe(-1);
  const after = await marker();
  expect(after.tabIds).toEqual([]);
  expect(after.group).toBeNull();
});

test("M1: a command naming a tab that does not exist fails closed", async () => {
  const missing = (await bridgeCall(bridge.port, bridge.token, "tabs.navigate", {
    tabId: 999_999,
    url: site.url("/done"),
  })) as unknown as { ok: boolean; error?: { code: string } };
  expect(missing.ok).toBe(false);
  expect(missing.error?.code).toBe("not_found");

  const badGroup = (await bridgeCall(bridge.port, bridge.token, "tabs.group", { tabIds: [] })) as unknown as {
    ok: boolean;
    error?: { code: string };
  };
  expect(badGroup.ok).toBe(false);
  expect(badGroup.error?.code).toBe("invalid_request");
});

test("M1: tabs.activate selects the tab without raising the window, and session.status reports a tab that vanished", async () => {
  // there was no way to select a tab, so a caller could not move a tab into
  // the only state some sites (and the other tools on this Chrome) act on — and a
  // tab the owner closed only surfaced as `not_found` on the next command.
  const page = await extension.context.newPage();
  await page.goto(site.url("/alpha"));
  const front = await extension.context.newPage();
  await front.goto("about:blank");
  await front.bringToFront();
  const tabId = (await listTabs()).find((row) => row.url === site.url("/alpha"))!.tabId;

  const activated = (await bridgeCall(bridge.port, bridge.token, "tabs.activate", { tabId })) as unknown as {
    ok: boolean;
    result?: { activated: boolean; windowRaised: boolean; wasActive: boolean };
    error?: { code: string };
  };
  expect(activated.ok, JSON.stringify(activated.error)).toBe(true);
  expect(activated.result?.activated).toBe(true);
  expect(activated.result?.wasActive).toBe(false);
  // Selecting a tab is not the same as raising the browser.
  expect(activated.result?.windowRaised).toBe(false);
  expect((await listTabs()).find((row) => row.tabId === tabId)?.active).toBe(true);

  // Drive it, then let the "owner" close it.
  await bridgeCall(bridge.port, bridge.token, "session.start", { tabIds: [tabId] });
  const status = (await bridgeCall(bridge.port, bridge.token, "session.status", {})) as unknown as {
    ok: boolean;
    result?: { drivenTabIds: number[]; presentTabIds: number[]; missingTabIds: number[]; marker: { group: unknown } };
  };
  expect(status.ok).toBe(true);
  expect(status.result?.missingTabIds).toEqual([]);
  expect(status.result?.presentTabIds).toEqual([tabId]);

  await page.close();
  const after = (await bridgeCall(bridge.port, bridge.token, "session.status", {})) as unknown as {
    result?: { drivenTabIds: number[]; presentTabIds: number[]; missingTabIds: number[] };
  };
  // The marker prunes a tab the moment Chrome reports it closed, which is the
  // better outcome; `missingTabIds` is the guard for a close the worker never saw
  // (a session that outlived its tab). Either way the tab is no longer driven, and
  // the caller can ask instead of waiting for `not_found`.
  expect(after.result?.drivenTabIds).toEqual([]);
  expect(after.result?.presentTabIds).toEqual([]);
  expect(after.result?.missingTabIds).toEqual([]);
});

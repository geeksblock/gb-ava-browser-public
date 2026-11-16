/**
 * The chrome.* side of M1: tabs and the marker group.
 *
 * Everything that decides *what* to do lives in `tabs.ts` and `marker.ts`; this
 * file only performs the calls and turns Chrome's failures into protocol errors.
 * That split is deliberate — the browser cannot be unit-tested, the decisions can.
 */

import {
  TAB_GROUP_COLOR,
  TAB_GROUP_TITLE,
  MAX_URL_LENGTH,
  isNavigableUrl,
  type CreateParams,
  type GroupParams,
  type ListParams,
  type NavigateParams,
  type TabDescriptor,
  type TabQuery,
  type JsonObject,
} from "@gb-ava/protocol";
import { commandError } from "./errors.js";
import { describeTabs, listTabs, missingTabIds, queryTabs, type RawTab } from "./tabs.js";

/**
 * How long a navigation may take before it is reported as a timeout. Kept under
 * the bridge's own request timeout (10 s) so the extension always answers first:
 * a caller should see "the page was slow", never "the extension went away".
 */
export const NAVIGATE_TIMEOUT_MS = 8_000;
const NAVIGATE_POLL_MS = 200;

/**
 * Compare what Chrome reports with what the caller asked for. Chrome normalises
 * URLs (`https://x` becomes `https://x/`), so a raw string comparison reports a
 * completed navigation as a timeout.
 */
function normalise(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

async function allTabs(): Promise<RawTab[]> {
  const tabs = await chrome.tabs.query({});
  return tabs as unknown as RawTab[];
}

/** A tab the caller named, or `not_found` — never a silent substitution. */
export async function requireTabs(tabIds: readonly number[]): Promise<RawTab[]> {
  const tabs = await allTabs();
  const missing = missingTabIds(tabs, tabIds);
  if (missing.length > 0) {
    throw commandError("not_found", `no such tab: ${missing.join(", ")}`, false, { tabIds: missing });
  }
  return tabs.filter((tab) => typeof tab.id === "number" && tabIds.includes(tab.id));
}

export async function listTabsCommand(params: ListParams): Promise<JsonObject> {
  const descriptors = listTabs(describeTabs(await allTabs()), params);
  return { tabs: descriptors as unknown as never, count: descriptors.length } as unknown as JsonObject;
}

export async function queryTabsCommand(query: TabQuery): Promise<JsonObject> {
  const matches = queryTabs(describeTabs(await allTabs()), query);
  return { tabs: matches as unknown as never, count: matches.length } as unknown as JsonObject;
}

/**
 * Navigate an explicit tab and wait for it to finish loading in the background.
 *
 * The tab is never focused: `chrome.tabs.update` with only a URL navigates without
 * stealing focus, which is the whole point of the product. A tab that disappears
 * mid-navigation is `not_found`; a page that never reaches `complete` is
 * `timeout`, with the last known state in `detail` so the caller can decide.
 */
export async function navigateCommand(params: NavigateParams): Promise<JsonObject> {
  const { tabId, url } = params;
  if (!isNavigableUrl(url) || url.length > MAX_URL_LENGTH) {
    throw commandError("invalid_request", `cannot navigate to ${url}`);
  }
  await requireTabs([tabId]);

  let beforeUrl: string | null = null;
  try {
    beforeUrl = (await chrome.tabs.get(tabId)).url ?? null;
  } catch {
    throw commandError("not_found", `no such tab: ${tabId}`);
  }

  try {
    await chrome.tabs.update(tabId, { url });
  } catch (error) {
    throw commandError("not_found", `cannot navigate tab ${tabId}: ${(error as Error).message}`);
  }

  return await waitForTabToLand(tabId, url, beforeUrl);
}

/**
 * Wait until a tab has actually landed on the requested navigation.
 *
 * Polls the tab's own state rather than waiting on onUpdated: a background tab
 * that finishes before the listener is attached would otherwise wait for an event
 * that will never come again.
 *
 * "complete" alone is not enough: for a moment after a navigation starts the tab
 * still reports the *previous* document, complete and with the old URL. A
 * navigation has landed only when the tab is at the requested URL, or at a
 * different URL than it started with (a redirect), or has been seen loading.
 *
 * Shared by `tabs.navigate` and `tabs.create` so a created tab and a navigated tab
 * are judged landed by exactly the same rule.
 */
async function waitForTabToLand(
  tabId: number,
  url: string,
  beforeUrl: string | null,
): Promise<JsonObject> {
  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  let lastStatus: string | null = null;
  let lastUrl: string | null = beforeUrl;
  let sawLoading = false;
  while (Date.now() < deadline) {
    let current: chrome.tabs.Tab;
    try {
      current = await chrome.tabs.get(tabId);
    } catch {
      throw commandError("not_found", `tab ${tabId} was closed during navigation`);
    }
    lastStatus = current.status ?? null;
    lastUrl = current.url ?? null;
    if (lastStatus === "loading") sawLoading = true;
    const target = normalise(url);
    const at = lastUrl === null ? null : normalise(lastUrl);
    const before = beforeUrl === null ? null : normalise(beforeUrl);
    // "complete" alone is not evidence: for a moment the tab still reports the
    // previous document. Landing means being at the target, or having genuinely
    // moved and finished (a redirect) — the latter needs a loading observation so
    // an unrelated older navigation cannot be mistaken for this one.
    const arrivedAtTarget = at === target;
    // A navigation that ends somewhere other than the target has landed if the tab
    // was seen loading — that is a redirect. With no previous document (a tab
    // `tabs.create` just opened, where `beforeUrl` is null) any other URL is still a
    // redirect; with one, the URL must also have actually moved.
    const redirected = at !== null && sawLoading && (before === null ? at !== target : at !== before);
    // A reload of the same URL cannot change anything, so loading is the only
    // evidence there is that it started.
    const landed = arrivedAtTarget || redirected || (before === target && sawLoading);
    if (lastStatus === "complete" && landed) {
      return {
        tabId,
        url: lastUrl ?? url,
        title: current.title ?? null,
        status: lastStatus,
      } as unknown as JsonObject;
    }
    await new Promise((resolve) => setTimeout(resolve, NAVIGATE_POLL_MS));
  }

  throw commandError(
    "timeout",
    `tab ${tabId} did not finish loading within ${NAVIGATE_TIMEOUT_MS} ms`,
    false,
    { tabId, status: lastStatus, url: lastUrl },
  );
}

/**
 * Open a new tab on `url`.
 *
 * The point of this method is to stay off the user's screen. `background`
 * defaults to true, and a background tab is created with `active: false` so
 * Chrome does not switch to it or raise the window — the tab is not fronted even
 * for an instant, which AppleScript could not promise.
 */
export async function createCommand(params: CreateParams): Promise<JsonObject> {
  const { url, windowId, pinned } = params;
  if (!isNavigableUrl(url) || url.length > MAX_URL_LENGTH) {
    throw commandError("invalid_request", `cannot open ${url}`);
  }
  const background = params.background !== false;

  const createProperties: chrome.tabs.CreateProperties = { url, active: !background };
  if (windowId !== undefined) createProperties.windowId = windowId;
  if (pinned !== undefined) createProperties.pinned = pinned;

  let created: chrome.tabs.Tab;
  try {
    created = await chrome.tabs.create(createProperties);
  } catch (error) {
    throw commandError("invalid_request", `cannot open a tab: ${(error as Error).message}`);
  }
  const tabId = created.id;
  if (tabId === undefined) {
    throw commandError("internal", "Chrome created a tab without an id");
  }
  // A created tab starts at about:blank (or the target) with no previous document,
  // so `beforeUrl` is null: landing is being at the target, or having been seen
  // loading. Same rule as a navigate.
  return await waitForTabToLand(tabId, url, null);
}

/**
 * Put tabs in the marker group, creating it on first use and re-asserting the
 * colour and title every time (a human may rename or recolour a group; the marker
 * must stay `red`/`Ava` because that is what the docs and the tests promise).
 *
 * `params.groupId` is the id the *caller* named: it is honoured or refused, never
 * swapped for another group. A group the marker remembers itself arrives through
 * `rememberedGroupId`, which may recover, because a stale marker id is the agent's own
 * bookkeeping rather than a caller's request.
 */
export async function groupCommand(
  params: GroupParams & { rememberedGroupId?: number | null },
): Promise<JsonObject> {
  const descriptors = await requireTabs(params.tabIds);
  const tabIds = descriptors
    .map((tab) => tab.id)
    .filter((id): id is number => typeof id === "number");
  const members = tabIds as [number, ...number[]];

  // Which group to try, and whether a failure may fall back to creating one:
  //
  //  - the caller named a groupId -> that id only. Chrome refusing it means the group
  //    does not exist, so the answer is `not_found`. Substituting a fresh group would
  //    move the tabs somewhere the caller never asked for and still answer `ok`
  //    (AGENTS.md §4 "ambiguous target -> explicit error"; §7 never fall back).
  //  - the marker's remembered id -> try it, then recover once by creating a group.
  //    The human may have closed it or the browser restarted; that is the marker's own
  //    bookkeeping going stale and there is no caller to mislead.
  //  - nothing -> create one.
  const named = params.groupId !== undefined;
  const remembered = !named && typeof params.rememberedGroupId === "number" ? params.rememberedGroupId : undefined;
  const candidates: Array<number | undefined> = named
    ? [params.groupId]
    : remembered !== undefined
      ? [remembered, undefined]
      : [undefined];

  let groupId: number | null = null;
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      groupId = (await (candidate === undefined
        ? chrome.tabs.group({ tabIds: members })
        : chrome.tabs.group({ tabIds: members, groupId: candidate }))) as number;
      break;
    } catch (error) {
      lastError = error as Error;
    }
  }
  if (groupId === null) {
    throw commandError("not_found", `cannot group tabs ${tabIds.join(", ")}: ${lastError?.message ?? "unknown error"}`);
  }

  await chrome.tabGroups.update(groupId, { color: TAB_GROUP_COLOR, title: TAB_GROUP_TITLE, collapsed: false });
  return { groupId, tabIds, color: TAB_GROUP_COLOR, title: TAB_GROUP_TITLE } as unknown as JsonObject;
}

/** Remove tabs from their group. The tabs stay open; only the marker goes. */
export async function ungroupCommand(params: { tabIds: number[] }): Promise<JsonObject> {
  const tabs = await allTabs();
  const live = tabs
    .filter((tab) => typeof tab.id === "number" && params.tabIds.includes(tab.id))
    .filter((tab) => (tab.groupId ?? -1) !== -1)
    .map((tab) => tab.id as number);

  if (live.length > 0) {
    try {
      await chrome.tabs.ungroup(live as [number, ...number[]]);
    } catch (error) {
      throw commandError("internal", `cannot ungroup tabs ${live.join(", ")}: ${(error as Error).message}`);
    }
  }
  return { ungroupedTabIds: live } as unknown as JsonObject;
}

/** Close one explicit tab. Closing the last marked tab closes the group itself. */
export async function closeCommand(params: { tabId: number }): Promise<JsonObject> {
  await requireTabs([params.tabId]);
  try {
    await chrome.tabs.remove(params.tabId);
  } catch (error) {
    throw commandError("not_found", `cannot close tab ${params.tabId}: ${(error as Error).message}`);
  }
  return { closedTabId: params.tabId } as unknown as JsonObject;
}

/**
 * Select a tab in its window.
 *
 * This is not "focus": `tabs.update({active: true})` selects the tab and does not
 * raise the window, so the owner's attention is untouched. `focusWindow` is the
 * explicit opt-in for raising it. The reply says what actually happened, because
 * only the caller knows whether raising the window was acceptable.
 */
export async function activateCommand(params: { tabId: number; focusWindow: boolean }): Promise<JsonObject> {
  const { tabId, focusWindow } = params;
  const [tab] = await requireTabs([tabId]);
  const windowId = tab?.windowId;
  try {
    const updated = await chrome.tabs.update(tabId, { active: true });
    let windowFocused: boolean | null = null;
    if (focusWindow && typeof windowId === "number") {
      const window = await chrome.windows.update(windowId, { focused: true }).catch(() => null);
      windowFocused = window?.focused === true;
    } else if (typeof windowId === "number") {
      const window = await chrome.windows.get(windowId).catch(() => null);
      windowFocused = window?.focused === true;
    }
    return {
      tabId,
      activated: updated?.active === true,
      windowId: windowId ?? null,
      // Whether the window came forward — the thing the owner would notice.
      windowFocused,
      // What happened, not what was asked: a failed windows.update must not claim
      // the window came forward.
      windowRaised: focusWindow && windowFocused === true,
      wasActive: tab?.active === true,
    } as unknown as JsonObject;
  } catch (error) {
    throw commandError("not_found", `cannot activate tab ${tabId}: ${(error as Error).message}`, false, { tabId });
  }
}

/**
 * The marker as the browser currently sees it, read live rather than remembered.
 * A group the human dissolved by hand must not be reported as present.
 */
export async function readMarkerGroup(groupId: number | null): Promise<JsonObject | null> {
  if (groupId === null) return null;
  try {
    const group = await chrome.tabGroups.get(groupId);
    return { groupId: group.id, color: group.color, title: group.title, collapsed: group.collapsed } as unknown as JsonObject;
  } catch {
    return null;
  }
}

/** Tabs currently in a group, from the live tab list. */
export async function tabsInGroup(groupId: number): Promise<number[]> {
  const tabs = await allTabs();
  return tabs
    .filter((tab) => (tab.groupId ?? -1) === groupId && typeof tab.id === "number")
    .map((tab) => tab.id as number);
}

/** Descriptors for the marker's tab set, for health and session replies. */
export async function describeTabsById(tabIds: readonly number[]): Promise<TabDescriptor[]> {
  if (tabIds.length === 0) return [];
  const tabs = await allTabs();
  return describeTabs(tabs.filter((tab) => typeof tab.id === "number" && tabIds.includes(tab.id)));
}

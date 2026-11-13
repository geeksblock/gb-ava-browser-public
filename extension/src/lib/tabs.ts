/**
 * Tab matching and the marker's tab set, as pure functions.
 *
 * Chrome's own `chrome.tabs.query` accepts a filter, but it cannot express
 * "url contains" or "title contains", and it silently ignores a property it does
 * not understand — the opposite of the fail-closed rule. So the extension always
 * lists and filters here, where the rules are explicit and unit-tested.
 *
 * Nothing in this file decides anything from group membership: the marker is a
 * visible signal for the human (plan §4), and the tab set is tracked by us.
 */

import type { TabDescriptor, TabQuery } from "@gb-ava/protocol";

/** The subset of a Chrome tab this module needs, so it can be unit-tested. */
export interface RawTab {
  id?: number | undefined;
  windowId?: number | undefined;
  index?: number | undefined;
  active?: boolean | undefined;
  pinned?: boolean | undefined;
  url?: string | undefined;
  title?: string | undefined;
  status?: string | undefined;
  groupId?: number | undefined;
}

const UNREADABLE_SCHEMES = ["chrome:", "chrome-extension:", "edge:", "about:"];

function readableUrl(url: string | undefined): string | null {
  if (url === undefined || url.length === 0) return null;
  return UNREADABLE_SCHEMES.some((scheme) => url.startsWith(scheme)) ? null : url;
}

/**
 * A tab with no id cannot be addressed, so it is dropped rather than surfaced
 * with a placeholder — an id the agent cannot use is worse than an absent row.
 */
export function describeTab(tab: RawTab): TabDescriptor | null {
  if (typeof tab.id !== "number") return null;
  return {
    tabId: tab.id,
    windowId: tab.windowId ?? -1,
    index: tab.index ?? 0,
    active: tab.active === true,
    pinned: tab.pinned === true,
    url: readableUrl(tab.url),
    title: tab.title ?? null,
    status: tab.status ?? null,
    groupId: tab.groupId ?? -1,
  };
}

export function describeTabs(tabs: readonly RawTab[]): TabDescriptor[] {
  const out: TabDescriptor[] = [];
  for (const tab of tabs) {
    const described = describeTab(tab);
    if (described !== null) out.push(described);
  }
  return out;
}

/**
 * Case-insensitive substring match on the URL, plus the same on the title. A
 * pattern is not a regex: an agent writing `?` or `.` must not get surprising
 * results, and a bad regex would need an error path for no benefit.
 */
function urlMatches(descriptor: TabDescriptor, urlPattern: string): boolean {
  if (descriptor.url === null) return false;
  return descriptor.url.toLowerCase().includes(urlPattern.toLowerCase());
}

function titleMatches(descriptor: TabDescriptor, titleContains: string): boolean {
  if (descriptor.title === null) return false;
  return descriptor.title.toLowerCase().includes(titleContains.toLowerCase());
}

/** Every predicate present must match; the caller already required at least one. */
export function matchesQuery(tab: TabDescriptor, query: TabQuery): boolean {
  if (query.urlPattern !== undefined && !urlMatches(tab, query.urlPattern)) return false;
  if (query.titleContains !== undefined && !titleMatches(tab, query.titleContains)) return false;
  if (query.groupId !== undefined && tab.groupId !== query.groupId) return false;
  if (query.windowId !== undefined && tab.windowId !== query.windowId) return false;
  if (query.active !== undefined && tab.active !== query.active) return false;
  if (query.pinned !== undefined && tab.pinned !== query.pinned) return false;
  return true;
}

export function queryTabs(tabs: readonly TabDescriptor[], query: TabQuery): TabDescriptor[] {
  return tabs.filter((tab) => matchesQuery(tab, query)).slice(0, query.limit);
}

export function listTabs(
  tabs: readonly TabDescriptor[],
  filter: { groupId?: number; windowId?: number; limit: number },
): TabDescriptor[] {
  return tabs
    .filter((tab) => (filter.groupId === undefined ? true : tab.groupId === filter.groupId))
    .filter((tab) => (filter.windowId === undefined ? true : tab.windowId === filter.windowId))
    .slice(0, filter.limit);
}

/**
 * Which tabs of a requested set are addressable right now. A tab can disappear
 * between the agent learning its id and using it, so this is checked before any
 * command rather than assumed.
 */
export function liveTabIds(tabs: readonly RawTab[], requested: readonly number[]): number[] {
  const live = new Set<number>();
  for (const tab of tabs) {
    if (typeof tab.id === "number") live.add(tab.id);
  }
  return requested.filter((id) => live.has(id));
}

export function missingTabIds(tabs: readonly RawTab[], requested: readonly number[]): number[] {
  const live = new Set(liveTabIds(tabs, requested));
  return requested.filter((id) => !live.has(id));
}

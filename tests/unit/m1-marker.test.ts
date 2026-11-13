import { describe, expect, it } from "vitest";
import {
  MARKER_GRACE_ALARM,
  MARKER_GRACE_MINUTES,
  initialMarkerState,
  reduceMarker,
  type MarkerState,
} from "../../extension/src/lib/marker.js";
import { describeTab, describeTabs, listTabs, matchesQuery, missingTabIds, queryTabs } from "../../extension/src/lib/tabs.js";
import type { TabQuery } from "@gb-ava/protocol";

const tab = (over: Record<string, unknown> = {}) => ({
  id: 1,
  windowId: 10,
  index: 0,
  active: false,
  pinned: false,
  url: "https://example.com/login",
  title: "Sign in",
  status: "complete",
  groupId: -1,
  ...over,
});

describe("tab descriptors", () => {
  it("drops a tab with no id rather than inventing one", () => {
    expect(describeTab({ title: "x" })).toBeNull();
    expect(describeTabs([tab(), { title: "no id" }])).toHaveLength(1);
  });

  it("reports the URL as null when the extension may not read it", () => {
    expect(describeTab(tab({ url: "chrome://settings" }))?.url).toBeNull();
    expect(describeTab(tab({ url: "edge://settings" }))?.url).toBeNull();
    expect(describeTab(tab())?.url).toBe("https://example.com/login");
  });

  it("keeps -1 for an ungrouped tab instead of nulling it", () => {
    expect(describeTab(tab())?.groupId).toBe(-1);
  });
});

describe("query matching", () => {
  const query = (over: Partial<TabQuery> = {}): TabQuery => ({ limit: 50, ...over });

  it("matches a URL substring case-insensitively", () => {
    expect(matchesQuery(describeTab(tab())!, query({ urlPattern: "EXAMPLE.com" }))).toBe(true);
    expect(matchesQuery(describeTab(tab())!, query({ urlPattern: "nope" }))).toBe(false);
  });

  it("treats the pattern as text, not a regular expression", () => {
    expect(matchesQuery(describeTab(tab({ url: "https://x.test/a.b" }))!, query({ urlPattern: "a.b" }))).toBe(true);
    // In a regex, "a?b" would match "b"; as a substring it matches nothing here.
    expect(matchesQuery(describeTab(tab({ url: "https://x.test/ab" }))!, query({ urlPattern: "a?b" }))).toBe(false);
  });

  it("never matches an unreadable tab's URL, even with an empty pattern", () => {
    expect(matchesQuery(describeTab(tab({ url: "chrome://newtab" }))!, query({ urlPattern: "chrome" }))).toBe(false);
  });

  it("requires every predicate to hold", () => {
    const descriptor = describeTab(tab({ active: true }))!;
    expect(matchesQuery(descriptor, query({ urlPattern: "example", active: true }))).toBe(true);
    expect(matchesQuery(descriptor, query({ urlPattern: "example", active: false }))).toBe(false);
  });

  it("bounds the result set", () => {
    const tabs = Array.from({ length: 120 }, (_, index) => describeTab(tab({ id: index + 1 }))!);
    expect(queryTabs(tabs, query({ urlPattern: "example", limit: 5 }))).toHaveLength(5);
    expect(listTabs(tabs, { limit: 200 })).toHaveLength(120);
  });
});

describe("liveness", () => {
  it("separates tabs that still exist from ones that do not", () => {
    const tabs = [tab({ id: 1 }), tab({ id: 2 })];
    expect(missingTabIds(tabs, [1, 9])).toEqual([9]);
    expect(missingTabIds(tabs, [1, 2])).toEqual([]);
  });
});

describe("marker lifecycle", () => {
  const started = (state: MarkerState = initialMarkerState()): MarkerState =>
    reduceMarker(state, { type: "session_start", sessionId: "s1", tabIds: [1, 2] }).state;

  it("groups the tabs a session starts with, and says red/Ava only through the effect", () => {
    const { state, effects } = reduceMarker(initialMarkerState(), {
      type: "session_start",
      sessionId: "s1",
      tabIds: [1, 2],
    });
    expect(state.sessionId).toBe("s1");
    expect(state.tabIds).toEqual([1, 2]);
    expect(effects).toEqual([{ type: "group", tabIds: [1, 2], groupId: null }]);
  });

  it("reuses the group it already owns instead of creating a second one", () => {
    const own = reduceMarker(started(), { type: "grouped", groupId: 7 }).state;
    const touched = reduceMarker(own, { type: "tabs_touched", tabIds: [3] });
    expect(touched.state.tabIds).toEqual([1, 2, 3]);
    expect(touched.effects).toEqual([{ type: "group", tabIds: [1, 2, 3], groupId: 7 }]);
  });

  it("paints nothing on navigate outside a session, but an explicit group always paints", () => {
    const touched = reduceMarker(initialMarkerState(), { type: "tabs_touched", tabIds: [5] });
    expect(touched.effects).toEqual([]);
    expect(touched.state.tabIds).toEqual([]);

    const grouped = reduceMarker(initialMarkerState(), { type: "tabs_grouped", tabIds: [5] });
    expect(grouped.state.tabIds).toEqual([5]);
    expect(grouped.effects).toEqual([{ type: "group", tabIds: [5], groupId: null }]);
  });

  it("releases the previous set when a new session names different tabs", () => {
    const own = reduceMarker(started(), { type: "grouped", groupId: 7 }).state;
    const again = reduceMarker(own, { type: "session_start", sessionId: "s2", tabIds: [9] });
    expect(again.effects[0]).toEqual({ type: "ungroup", tabIds: [1, 2] });
    expect(again.effects[1]).toEqual({ type: "group", tabIds: [9], groupId: null });
    expect(again.state.tabIds).toEqual([9]);
    expect(again.state.sessionId).toBe("s2");
  });

  it("keeps the tab set until the ungroup is confirmed, so a failure can be retried", () => {
    const own = reduceMarker(started(), { type: "grouped", groupId: 7 }).state;
    const ended = reduceMarker(own, { type: "session_end" });
    expect(ended.state.sessionId).toBeNull();
    expect(ended.state.tabIds).toEqual([1, 2]);
    expect(ended.effects[0]).toEqual({ type: "ungroup", tabIds: [1, 2] });

    const confirmed = reduceMarker(ended.state, { type: "ungrouped" });
    expect(confirmed.state.tabIds).toEqual([]);
    expect(confirmed.state.grouped).toBe(false);
    expect(confirmed.state.groupId).toBeNull();
  });

  it("keeps the remaining tabs when one is closed, and forgets the group when the last goes", () => {
    const own = reduceMarker(started(), { type: "grouped", groupId: 7 }).state;
    const one = reduceMarker(own, { type: "tab_closed", tabId: 1 });
    expect(one.state.tabIds).toEqual([2]);
    expect(one.effects).toEqual([]);
    const none = reduceMarker(one.state, { type: "tab_closed", tabId: 2 });
    expect(none.state.tabIds).toEqual([]);
    expect(none.state.groupId).toBeNull();
    expect(none.effects).toEqual([{ type: "ungroup", tabIds: [] }]);
  });

  it("does not ungroup a tab the human already released", () => {
    const released = reduceMarker(started(), { type: "tabs_ungrouped", tabIds: [1] });
    expect(released.state.tabIds).toEqual([2]);
    expect(reduceMarker(released.state, { type: "session_end" }).effects).toEqual([
      { type: "ungroup", tabIds: [2] },
      { type: "note", message: "session ended" },
    ]);
  });

  it("arms a grace alarm when the bridge goes, and cancels it when it returns", () => {
    const gone = reduceMarker(started(), { type: "bridge_gone" });
    expect(gone.state.ungroupArmed).toBe(true);
    expect(gone.effects[0]).toEqual({ type: "arm_grace", minutes: MARKER_GRACE_MINUTES });
    const back = reduceMarker(gone.state, { type: "bridge_back" });
    expect(back.state.ungroupArmed).toBe(false);
    expect(back.effects).toEqual([{ type: "clear_grace" }]);
  });

  it("does not restart the grace when the bridge is reported gone again", () => {
    // Every failed reconnect attempt reports bridge_gone; each one re-arming the
    // alarm pushed the deadline out for as long as the bridge was away.
    const armed = reduceMarker(started(), { type: "bridge_gone" }).state;
    const again = reduceMarker(armed, { type: "bridge_gone" });
    expect(again.effects).toEqual([]);
    expect(again.state.tabIds).toEqual([1, 2]);
  });

  it("ungroups when the grace expires with the bridge still gone", () => {
    const armed = reduceMarker(started(), { type: "bridge_gone" }).state;
    const expired = reduceMarker(armed, { type: "grace_expired", stillDisconnected: true });
    expect(expired.state.sessionId).toBeNull();
    expect(expired.effects[0]).toEqual({ type: "ungroup", tabIds: [1, 2] });
  });

  it("is a deadline: a failed reconnect cannot extend it", () => {
    // The regression this pins: an "attempt in flight, check again" branch in the
    // grace path meant the alarm re-armed every 30 s for as long as the bridge was
    // away, so the marker never ungrouped.
    const armed = reduceMarker(started(), { type: "bridge_gone" }).state;
    const expired = reduceMarker(armed, { type: "grace_expired", stillDisconnected: true });
    expect(expired.state.sessionId).toBeNull();
    expect(expired.effects.map((effect) => effect.type)).toEqual(["ungroup", "note"]);
  });

  it("keeps the marker when the bridge came back before the alarm fired", () => {
    const armed = reduceMarker(started(), { type: "bridge_gone" }).state;
    const expired = reduceMarker(armed, { type: "grace_expired", stillDisconnected: false });
    expect(expired.state.tabIds).toEqual([1, 2]);
    expect(expired.effects).toEqual([{ type: "clear_grace" }]);
  });

  it("does not arm a grace alarm for an empty marker", () => {
    const idle = reduceMarker(initialMarkerState(), { type: "session_start", sessionId: "s1", tabIds: [] }).state;
    expect(reduceMarker(idle, { type: "bridge_gone" }).effects).toEqual([]);
  });

  it("resets after a browser restart, releasing whatever it held", () => {
    const own = reduceMarker(started(), { type: "grouped", groupId: 7 }).state;
    const reset = reduceMarker(own, { type: "reset", reason: "browser_start" });
    expect(reset.state).toEqual(initialMarkerState());
    expect(reset.effects).toEqual([
      { type: "ungroup", tabIds: [1, 2] },
      { type: "clear_grace" },
      { type: "note", message: "marker reset", fields: { reason: "browser_start" } },
    ]);
  });

  it("re-groups into a fresh group when the known group is gone", () => {
    // The reducer still hands over the remembered id; the effect is what tells
    // the caller to fall back, and the worker's group command does exactly one
    // retry without it.
    const own = reduceMarker(started(), { type: "grouped", groupId: 7 }).state;
    const touched = reduceMarker(own, { type: "tabs_touched", tabIds: [3] });
    expect(touched.effects).toEqual([{ type: "group", tabIds: [1, 2, 3], groupId: 7 }]);
  });

  it("has a grace that is Chrome's minimum and an alarm name the worker owns", () => {
    expect(MARKER_GRACE_MINUTES).toBe(1);
    expect(MARKER_GRACE_ALARM).toBe("ava.ungroup-marker");
  });
});

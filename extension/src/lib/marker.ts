/**
 * The marker lifecycle, as a pure state machine (plan §4).
 *
 * The marker is the visible "Ava is driving" signal: one red group titled `Ava`,
 * tabs joining as they are touched, everything ungrouped when the session ends,
 * the last tab in it closes, or the bridge has been gone for a grace period.
 *
 * Rules that shape this file:
 *   - the group is cosmetic, never load-bearing: the tab set is tracked here, and
 *     no decision reads group membership back from Chrome;
 *   - there is exactly one group, and its id is reused: creating a second one
 *     would leave the first empty and delete it, and the caller would hold a dead
 *     id (this was a real defect, caught in review);
 *   - a cleared tab set is only forgotten after the ungroup effect succeeded, so
 *     a failed ungroup can be retried instead of leaking a group;
 *   - an ungroup always happens, even after a crash: the grace ungroup is an
 *     alarm, which survives the service worker dying (a setTimeout would not).
 *
 * Effects are returned, not executed, so the service worker stays thin and this
 * file stays testable without chrome.*.
 */

export const MARKER_GROUP_COLOR = "red" as const;
export const MARKER_GROUP_TITLE = "Ava" as const;
export const MARKER_GRACE_ALARM = "ava.ungroup-marker";
/** Chrome's minimum alarm delay is 30 s; one minute is a deliberate, visible grace. */
export const MARKER_GRACE_MINUTES = 1;

export interface MarkerState {
  /** Tabs the agent has touched in this session. Authority, not the group. */
  tabIds: number[];
  sessionId: string | null;
  /** Whether a group has been created for this session. */
  grouped: boolean;
  /** The group we created, when the browser has told us. */
  groupId: number | null;
  /** Ungroup is pending because the bridge went away. */
  ungroupArmed: boolean;
}

export type MarkerEvent =
  | { type: "session_start"; sessionId: string; tabIds: number[] }
  | { type: "tabs_grouped"; tabIds: number[] }
  | { type: "tabs_grouped_undone"; tabIds: number[]; previous: MarkerState }
  | { type: "tabs_touched"; tabIds: number[] }
  | { type: "tabs_ungrouped"; tabIds: number[] }
  | { type: "session_end" }
  | { type: "tab_closed"; tabId: number }
  | { type: "bridge_gone" }
  | { type: "bridge_back" }
  | { type: "grace_expired"; stillDisconnected: boolean }
  | { type: "grouped"; groupId: number }
  | { type: "ungrouped" }
  | { type: "group_lost"; reason: string }
  | { type: "reset"; reason: string };

export type MarkerEffect =
  | { type: "group"; tabIds: number[]; groupId: number | null }
  | { type: "ungroup"; tabIds: number[] }
  | { type: "arm_grace"; minutes: number }
  | { type: "clear_grace" }
  | { type: "note"; message: string; fields?: Record<string, unknown> };

export interface MarkerResult {
  state: MarkerState;
  effects: MarkerEffect[];
}

export function initialMarkerState(): MarkerState {
  return { tabIds: [], sessionId: null, grouped: false, groupId: null, ungroupArmed: false };
}

function unique(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const setA = [...a].sort((x, y) => x - y);
  const setB = [...b].sort((x, y) => x - y);
  return setA.every((value, index) => value === setB[index]);
}

/**
 * A session end (or an expired grace) keeps the tab set until the ungroup has
 * actually happened: `ungrouped` is what clears it. Losing the ids before the
 * browser confirmed would strand those tabs in the group for good.
 */
function endSession(state: MarkerState, note: string): MarkerResult {
  if (state.tabIds.length === 0) {
    return { state: { ...initialMarkerState() }, effects: [{ type: "ungroup", tabIds: [] }] };
  }
  return {
    state: { ...state, sessionId: null, ungroupArmed: false },
    effects: [{ type: "ungroup", tabIds: [...state.tabIds] }, { type: "note", message: note }],
  };
}

export function reduceMarker(state: MarkerState, event: MarkerEvent): MarkerResult {
  switch (event.type) {
    case "session_start": {
      const tabIds = unique(event.tabIds);
      // A new session that names different tabs releases the old set first: two
      // live sessions would mean two markers, and `session.end` could only reach
      // one of them. A start that names *no* tabs keeps the set it has: it may be
      // the same session starting again (a retry, a reconnecting caller), and
      // silently ungrouping live tabs there is a marker the caller did not ask for.
      const releasing = state.tabIds.length > 0 && tabIds.length > 0 && !sameSet(state.tabIds, tabIds);
      const next: MarkerState = {
        ...state,
        sessionId: event.sessionId,
        tabIds: releasing ? tabIds : unique([...state.tabIds, ...tabIds]),
        grouped: releasing ? tabIds.length > 0 : state.grouped || tabIds.length > 0,
      };
      const effects: MarkerEffect[] = [];
      if (releasing) effects.push({ type: "ungroup", tabIds: [...state.tabIds] });
      if (tabIds.length > 0) {
        effects.push({ type: "group", tabIds: next.tabIds, groupId: releasing ? null : state.groupId });
      }
      return { state: next, effects };
    }

    case "tabs_grouped": {
      // An explicit `tabs.group` paints even outside a session: the caller asked
      // for the marker, so it gets one.
      //
      // The set is claimed before the paint, so a Chrome refusal does not leave
      // the reducer's set unchanged: `tabs_grouped_undone` puts it back. Without
      // that, `tabs.group` would report (and `session.status` would later show) a
      // tab as marked that the human never saw join the group.
      const added = unique([...state.tabIds, ...event.tabIds]);
      return {
        state: { ...state, tabIds: added, grouped: true },
        effects: [{ type: "group", tabIds: added, groupId: state.groupId }],
      };
    }

    case "tabs_grouped_undone": {
      // The paint failed, so the tabs never joined the marker: put back exactly the
      // state from before `tabs_grouped`. Marker work is serialised in the worker
      // (one dispatch at a time), so the snapshot is still the right baseline.
      return { state: { ...event.previous }, effects: [] };
    }

    case "tabs_touched": {
      if (state.sessionId === null) {
        // A navigate outside a session must not paint a group nobody asked for.
        return { state, effects: [] };
      }
      const added = unique([...state.tabIds, ...event.tabIds]);
      // Repaint when the set changed *or* when we know the group is gone: the
      // human may have dissolved it, and a touch is the moment to restore it.
      if (sameSet(added, state.tabIds) && state.grouped) return { state, effects: [] };
      return {
        state: { ...state, tabIds: added, grouped: true },
        effects: [{ type: "group", tabIds: added, groupId: state.groupId }],
      };
    }

    case "group_lost": {
      // Chrome no longer has the group we remembered (the human closed it, or the
      // browser restarted). Keep the tabs, forget the id, so the next touch paints
      // a fresh one instead of retrying a dead id.
      return {
        state: { ...state, grouped: false, groupId: null },
        effects: [{ type: "note", message: "marker group is gone; it will be repainted", fields: { reason: event.reason } }],
      };
    }

    case "tabs_ungrouped": {
      // An explicit ungroup leaves the marker's set as well, so health and
      // session.end never report tabs the human already released.
      const tabIds = state.tabIds.filter((id) => !event.tabIds.includes(id));
      const grouped = tabIds.length > 0 && state.grouped;
      return {
        // An emptied marker no longer owns a group: Chrome deletes a group that
        // has no tabs, so keeping the id would offer a dead one as current.
        state: { ...state, tabIds, grouped, groupId: grouped ? state.groupId : null },
        effects: [],
      };
    }

    case "session_end":
      return endSession(state, "session ended");

    case "tab_closed": {
      const tabIds = state.tabIds.filter((id) => id !== event.tabId);
      if (tabIds.length > 0) return { state: { ...state, tabIds }, effects: [] };
      // Chrome drops an emptied group itself; this only fixes our own record.
      return {
        state: { ...state, tabIds: [], grouped: false, groupId: null },
        effects: state.grouped ? [{ type: "ungroup", tabIds: [] }] : [],
      };
    }

    case "bridge_gone": {
      if (state.tabIds.length === 0) return { state, effects: [] };
      // Already counting down: re-arming would push the deadline out again.
      // Every failed reconnect attempt reports the bridge as gone, and a grace
      // that restarts on each attempt never expires (found in an integration test).
      if (state.ungroupArmed) return { state, effects: [] };
      return {
        state: { ...state, ungroupArmed: true },
        effects: [
          { type: "arm_grace", minutes: MARKER_GRACE_MINUTES },
          { type: "note", message: "bridge gone; marker ungroups after grace" },
        ],
      };
    }

    case "bridge_back": {
      if (!state.ungroupArmed) return { state, effects: [] };
      return { state: { ...state, ungroupArmed: false }, effects: [{ type: "clear_grace" }] };
    }

    case "grace_expired": {
      if (!state.ungroupArmed) return { state, effects: [] };
      // The grace is an absolute deadline, not something a failing reconnect can
      // extend: while the bridge was away, an attempt was in flight often enough
      // that a "re-check later" branch renewed it forever and the marker never
      // ungrouped at all (found by the integration test, then by diagnostics).
      // If the bridge returns before the alarm fires, `bridge_back` cancels it.
      if (event.stillDisconnected) return endSession(state, "bridge gone past grace");
      return { state: { ...state, ungroupArmed: false }, effects: [{ type: "clear_grace" }] };
    }

    case "grouped":
      return { state: { ...state, grouped: true, groupId: event.groupId }, effects: [] };

    case "ungrouped":
      return {
        state: {
          ...state,
          grouped: false,
          groupId: null,
          tabIds: state.sessionId === null ? [] : state.tabIds,
        },
        effects: [],
      };

    case "reset":
      return {
        state: { ...initialMarkerState() },
        effects: [
          { type: "ungroup", tabIds: [...state.tabIds] },
          { type: "clear_grace" },
          { type: "note", message: "marker reset", fields: { reason: event.reason } },
        ],
      };

    default: {
      const exhaustive: never = event;
      return { state, effects: [{ type: "note", message: `unhandled marker event ${JSON.stringify(exhaustive)}` }] };
    }
  }
}

/**
 * The marker's durable state.
 *
 * MV3 workers are suspended and restarted, so a session that survives a worker
 * restart has to survive in storage. This is state, not authority: on every read
 * the group itself is queried from Chrome, and a group that no longer exists is
 * reported as absent rather than remembered.
 */

import type { MarkerState } from "./marker.js";

const MARKER_KEY = "markerState";

const EMPTY: MarkerState = { tabIds: [], sessionId: null, grouped: false, groupId: null, ungroupArmed: false };

export async function loadMarkerState(): Promise<MarkerState> {
  try {
    const raw = await chrome.storage.local.get([MARKER_KEY]);
    const stored = raw[MARKER_KEY];
    if (typeof stored !== "object" || stored === null) return { ...EMPTY };
    const record = stored as Record<string, unknown>;
    // Storage is not trust. A corrupt or hand-edited record must degrade to "nothing
    // is marked", never hand the worker a NaN tab id or a group it does not have:
    // the marker drives real chrome.tabs.group/ungroup calls, so a bad id there is
    // a bad command, not a cosmetic glitch (#33 item 5).
    const tabIds = Array.isArray(record["tabIds"])
      ? record["tabIds"].filter(
          (id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id >= 0,
        )
      : [];
    const grouped = record["grouped"] === true;
    const rawGroupId = record["groupId"];
    const groupId =
      grouped && typeof rawGroupId === "number" && Number.isSafeInteger(rawGroupId) && rawGroupId >= 0
        ? rawGroupId
        : null;
    return {
      tabIds,
      sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : null,
      // A groupId without `grouped` is not a marker: the reducer would offer a group
      // the human never saw, which is the bug class #29 closed.
      grouped: grouped && groupId !== null,
      groupId,
      ungroupArmed: record["ungroupArmed"] === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveMarkerState(state: MarkerState): Promise<void> {
  await chrome.storage.local.set({ [MARKER_KEY]: state });
}

/**
 * Schema and storage gaps, each pinned by the behaviour that was reported.
 *
 *   item 2 — `page.waitFor` with an invalid selector reported `timeout`
 *   item 3 — `browser_session_start`'s schema forbade what its text described
 *   item 4 — the MCP server advertised a schema it never enforced
 *   item 5 — `loadMarkerState` accepted NaN, fractional and negative tab ids
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAgainstSchema } from "../../mcp/src/server.js";
import { MCP_TOOLS } from "../../mcp/src/tools.js";
import { loadMarkerState } from "../../extension/src/lib/marker-store.js";

/* ---------------------------------------------------------------- */
/* item 4 — the advertised schema is enforced                        */
/* ---------------------------------------------------------------- */

describe("the MCP server holds a caller to the schema it advertises", () => {
  const waitTool = MCP_TOOLS.find((tool) => tool.name === "browser_wait");

  it("has a browser_wait tool to check against", () => {
    expect(waitTool).toBeDefined();
  });

  it("refuses a null where a string is advertised", () => {
    // The bug: String(null) becomes "null" and is sent to the bridge as a real
    // search term, so a well-formed call fails with the blame in the wrong place.
    const problem = checkAgainstSchema(waitTool!.inputSchema, { tabId: 1, text: null });
    expect(problem).toBe("text must be a string");
  });

  it("refuses a number where a string is advertised", () => {
    expect(checkAgainstSchema(waitTool!.inputSchema, { tabId: 1, text: 42 })).toBe("text must be a string");
  });

  it("refuses a fractional tabId", () => {
    expect(checkAgainstSchema(waitTool!.inputSchema, { tabId: 1.5 })).toBe("tabId must be an integer");
  });

  it("refuses a negative tabId", () => {
    expect(checkAgainstSchema(waitTool!.inputSchema, { tabId: -1 })).toBe("tabId must be at least 0");
  });

  it("refuses a missing required parameter, naming it", () => {
    expect(checkAgainstSchema(waitTool!.inputSchema, {})).toBe("missing required parameter: tabId");
  });

  it("refuses a parameter that is not in the schema", () => {
    expect(checkAgainstSchema(waitTool!.inputSchema, { tabId: 1, sneaky: true })).toBe("unknown parameter: sneaky");
  });

  it("accepts a conforming call", () => {
    expect(checkAgainstSchema(waitTool!.inputSchema, { tabId: 1, text: "Done", timeoutMs: 500 })).toBeNull();
  });

  it("checks array item types", () => {
    const start = MCP_TOOLS.find((tool) => tool.name === "browser_session_start")!;
    expect(checkAgainstSchema(start.inputSchema, { tabIds: [1, "two" as unknown as number] })).toBe(
      "tabIds[1] must be a number",
    );
    expect(checkAgainstSchema(start.inputSchema, { tabIds: [1, 2] })).toBeNull();
  });

  it("applies to every tool in the table, not one special case", () => {
    // A schema the checker cannot enforce would be a silent hole. Every advertised
    // tool must reject *something*: an undeclared key, which every schema forbids.
    // (browser_tabs legitimately takes no arguments, so "reject {}" is not the test.)
    for (const tool of MCP_TOOLS) {
      // Either complaint is a correct rejection — a tool with required parameters
      // may report the missing one first. What must never happen is `null`.
      expect(
        checkAgainstSchema(tool.inputSchema, { definitelyNotAParameter: 1 }),
        `${tool.name} accepted an undeclared parameter`,
      ).not.toBeNull();
    }
  });
});

/* ---------------------------------------------------------------- */
/* item 3 — the schema no longer contradicts the description         */
/* ---------------------------------------------------------------- */

describe("browser_session_start's schema matches what it says", () => {
  const start = MCP_TOOLS.find((tool) => tool.name === "browser_session_start")!;

  it("does not forbid the empty array its description allows", () => {
    const properties = start.inputSchema["properties"] as Record<string, Record<string, unknown>>;
    const tabIds = properties["tabIds"];
    expect(tabIds, "tabIds must still be a declared property").toBeDefined();
    expect(tabIds!["minItems"]).toBeUndefined();
  });

  it("says what an omitted list does, so a retry is not mistaken for a clear", () => {
    expect(start.description).toContain("does not clear them");
  });

  it("accepts an empty array and an omitted list", () => {
    expect(checkAgainstSchema(start.inputSchema, { tabIds: [] })).toBeNull();
    expect(checkAgainstSchema(start.inputSchema, {})).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* item 5 — stored marker state is not trusted                       */
/* ---------------------------------------------------------------- */

describe("loadMarkerState refuses corrupt storage", () => {
  function withStored(stored: unknown): void {
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({ markerState: stored })),
          set: vi.fn(async () => undefined),
        },
      },
    };
  }

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it("drops NaN, fractional and negative tab ids instead of passing them on", async () => {
    withStored({ tabIds: [1, Number.NaN, 2.5, -3, 4], sessionId: "s" });
    const state = await loadMarkerState();
    // Only the ids a real chrome.tabs call could accept survive.
    expect(state.tabIds).toEqual([1, 4]);
  });

  it("ignores a groupId when the state does not claim to be grouped", async () => {
    withStored({ tabIds: [1], grouped: false, groupId: 7 });
    const state = await loadMarkerState();
    expect(state.groupId).toBeNull();
    expect(state.grouped).toBe(false);
  });

  it("keeps a valid grouped state", async () => {
    withStored({ tabIds: [1], grouped: true, groupId: 7, sessionId: "s" });
    const state = await loadMarkerState();
    expect(state).toMatchObject({ tabIds: [1], grouped: true, groupId: 7, sessionId: "s" });
  });

  it("drops a corrupt groupId but keeps the tabs", async () => {
    withStored({ tabIds: [1], grouped: true, groupId: 2.5 });
    const state = await loadMarkerState();
    expect(state.tabIds).toEqual([1]);
    expect(state.groupId).toBeNull();
    expect(state.grouped).toBe(false);
  });

  it("returns the empty state for anything that is not a record", async () => {
    withStored("nonsense");
    expect(await loadMarkerState()).toMatchObject({ tabIds: [], sessionId: null, grouped: false, groupId: null });
  });
});

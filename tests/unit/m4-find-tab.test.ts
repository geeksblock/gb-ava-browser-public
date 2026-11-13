import { describe, expect, it } from "vitest";
import { browser_find_tab } from "../../adapter/src/tools.js";
import type { ToolContext } from "../../adapter/src/tools.js";

/**
 * `browser_find_tab` advertised `urlIncludes`, but forwarded its params verbatim to `tabs.query`,
 * which accepts `urlPattern` and refuses unknown keys. Every URL lookup was an `invalid_request`.
 * These tests pin the parameter name the protocol actually sees.
 */

interface Captured {
  method: string;
  params: Record<string, unknown>;
}

function recordingContext(): { context: ToolContext; calls: Captured[] } {
  const calls: Captured[] = [];
  const client = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      return { tabs: [], count: 0 };
    },
  };
  return { context: { client } as unknown as ToolContext, calls };
}

/** The single call the adapter forwarded, failing the test if there were none or more than one. */
function onlyCall(calls: Captured[]): Captured {
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

describe("browser_find_tab speaks the protocol's parameter name", () => {
  it("sends urlIncludes to the bridge as urlPattern", async () => {
    const { context, calls } = recordingContext();
    await browser_find_tab(context, { urlIncludes: "marketplace/create" });

    const call = onlyCall(calls);
    expect(call.method).toBe("tabs.query");
    expect(call.params).toEqual({ urlPattern: "marketplace/create" });
    expect(call.params).not.toHaveProperty("urlIncludes");
  });

  it("passes titleContains through unchanged", async () => {
    const { context, calls } = recordingContext();
    await browser_find_tab(context, { titleContains: "Create new listing" });

    expect(onlyCall(calls).params).toEqual({ titleContains: "Create new listing" });
  });

  it("carries both filters in one query", async () => {
    const { context, calls } = recordingContext();
    await browser_find_tab(context, { urlIncludes: "facebook.com", titleContains: "Marketplace" });

    expect(onlyCall(calls).params).toEqual({
      urlPattern: "facebook.com",
      titleContains: "Marketplace",
    });
  });

  it("omits a filter that was not supplied rather than sending undefined", async () => {
    const { context, calls } = recordingContext();
    await browser_find_tab(context, { urlIncludes: "example.com" });

    expect(Object.keys(onlyCall(calls).params)).toEqual(["urlPattern"]);
  });

  it("lists every tab when called with no filter", async () => {
    const { context, calls } = recordingContext();
    await browser_find_tab(context, {});

    expect(onlyCall(calls)).toEqual({ method: "tabs.query", params: {} });
  });

  // An empty pattern would match every URL (`"".includes("")` is true in the extension), so it is
  // forwarded rather than silently dropped, and the protocol's readString refuses it with a clear
  // error. Pin that: an empty filter must fail loudly, never quietly widen the query.
  it("forwards an empty urlIncludes so the protocol refuses it, rather than widening the query", async () => {
    const { context, calls } = recordingContext();
    await browser_find_tab(context, { urlIncludes: "" });

    expect(onlyCall(calls).params).toEqual({ urlPattern: "" });
  });
});

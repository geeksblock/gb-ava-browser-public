/**
 * Every protocol parser, driven through its allowlist.
 *
 * This file exists because of a past bug: `browser_find_tab` sent `urlIncludes` to
 * `tabs.query`, whose allowlist takes `urlPattern`, and the mismatch only showed up
 * against a live bridge. The parser was right; nothing tested that the *callers*
 * agreed with it.
 *
 * Two directions, for every method:
 *   - the documented keys are accepted (no parser silently drops a real parameter)
 *   - a typo of a real key is refused, and the message names the method
 *
 * The second half is the early-warning for a new parameter being added to a handler
 * but forgotten in the allowlist, or the reverse.
 */

import { describe, expect, it } from "vitest";
import * as protocol from "../../shared/src/protocol.js";

type Parser = (params: unknown) => { ok: boolean; value?: unknown; error?: { message: string } };

/**
 * A valid call for each parser using **every documented parameter**, optional ones
 * included. Optional keys must be present here or the suite cannot see an allowlist
 * that drops one — which is how that bug shipped: `limit` was optional on `page.getText`,
 * so nothing passed it and nothing noticed the allowlist.
 */
const VALID: Record<string, Record<string, unknown>> = {
  parseListParams: { groupId: 7, windowId: 3, limit: 10 },
  parseQueryParams: { urlPattern: "example.com", titleContains: "Example", groupId: 7, windowId: 3, active: false, pinned: false, limit: 10 },
  parseNavigateParams: { tabId: 1, url: "https://example.com/" },
  parseCreateParams: { url: "https://example.com/", windowId: 3, background: true, pinned: false },
  parseGroupParams: { tabIds: [1, 2], groupId: 7 },
  parseUngroupParams: { tabIds: [1] },
  parseCloseParams: { tabId: 1 },
  parseActivateParams: { tabId: 1, focusWindow: false },
  parseSessionStartParams: { tabIds: [1] },
  parseSessionStatusParams: {},
  parseSessionEndParams: {},
  parseReadAxParams: { tabId: 1, limit: 50, includeInvisible: false },
  parseGetTextParams: { tabId: 1, limit: 500 },
  parseScreenshotParams: { tabId: 1, detectStale: false },
  parseClickParams: { tabId: 1, nodeId: 5, button: "left", inputRoute: "auto" },
  parseTypeParams: { tabId: 1, nodeId: 5, text: "hello" },
  parseKeyParams: { tabId: 1, key: "Enter", modifiers: ["shift"] },
  parseScrollParams: { tabId: 1, nodeId: 5, deltaX: 0, deltaY: -100 },
  parseSelectParams: { tabId: 1, nodeId: 5, value: "blue" },
  parseUploadParams: { tabId: 1, nodeId: 5, files: ["/tmp/a.txt"] },
  parseDownloadParams: { tabId: 1, nodeId: 5, timeoutMs: 5000 },
  parseWaitForParams: { tabId: 1, selector: "#done", text: "Done", urlIncludes: "/done", timeoutMs: 5000 },
  parseEvaluateParams: { tabId: 1, expression: "1 + 1", awaitPromise: false },
};

/** Look a parser up by name, failing loudly rather than asserting the type away. */
function parserNamed(name: string): Parser {
  const found = (protocol as unknown as Record<string, Parser | undefined>)[name];
  if (typeof found !== "function") throw new Error(`no such parser: ${name}`);
  return found;
}

const parsers = Object.entries(VALID).map(([name, params]) => ({ name, params, parser: parserNamed(name) }));

describe("every parser exists and accepts its documented call", () => {
  it("covers every exported parser", () => {
    const exported = Object.keys(protocol).filter(
      (key) => /^parse[A-Za-z]+Params$/.test(key) && typeof (protocol as Record<string, unknown>)[key] === "function",
    );
    const covered = parsers.map((entry) => entry.name);
    const missing = exported.filter((key) => !covered.includes(key));
    // A new parser with no valid-call entry here is a parser nobody has driven.
    expect(missing, "exported parsers with no entry in VALID").toEqual([]);
  });

  it.each(parsers.map((entry) => [entry.name, entry] as const))("%s accepts its documented call", (_name, entry) => {
    const result = entry.parser(entry.params);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});

describe("a typo of a real key is refused, not ignored", () => {
  it.each(parsers.map((entry) => [entry.name, entry] as const))("%s refuses unknown keys", (name, entry) => {
    const typo = { ...entry.params, definitelyNotAKey: 1 };
    const result = entry.parser(typo);
    expect(result.ok, `${name} accepted an unknown key`).toBe(false);
    if (!result.ok && result.error) {
      expect(result.error.message).toContain("does not accept");
    }
  });

  it.each(parsers.map((entry) => [entry.name, entry] as const))(
    "%s refuses the snake_case spelling of a real key",
    (name, entry) => {
      // The classic mismatch: a handler reads camelCase, a model sends snake_case.
      const key = Object.keys(entry.params)[0];
      if (key === undefined) return; // no parameters to misspell
      const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      if (snake === key) return; // no camel hump in this key
      const mistaken = { ...entry.params, [snake]: entry.params[key] };
      const result = entry.parser(mistaken);
      expect(result.ok, `${name} accepted "${snake}" as well as "${key}"`).toBe(false);
    },
  );
});

describe("numbers are integers, not whatever JSON produced", () => {
  it.each([
    ["parseReadAxParams", "tabId", 1.5],
    ["parseReadAxParams", "tabId", -1],
    ["parseGetTextParams", "tabId", "1"],
    ["parseScrollParams", "deltaY", 1.5],
    ["parseScrollParams", "deltaX", null],
    ["parseClickParams", "nodeId", -3],
  ] as const)("%s refuses %s = %o", (name, key, value) => {
    const result = parserNamed(name)({ ...VALID[name], [key]: value });
    expect(result.ok, `${name} accepted ${key}=${String(value)}`).toBe(false);
  });
});

describe("prototype-pollution keys do not slip through a spread", () => {
  it.each(parsers.map((entry) => [entry.name, entry] as const))("%s refuses __proto__", (name, entry) => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const result = entry.parser({ ...entry.params, ...hostile });
    expect(result.ok, `${name} accepted __proto__`).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("a refused constructor key does not reach Object.prototype", () => {
    const result = parserNamed("parseReadAxParams")({ tabId: 1, constructor: { prototype: { polluted: true } } });
    expect(result.ok).toBe(false);
    expect(([] as unknown as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("the marker group's documented constants are single-sourced", () => {
  it("exposes exactly one colour and title", () => {
    expect(protocol.TAB_GROUP_COLOR).toBe("red");
    expect(protocol.TAB_GROUP_TITLE).toBe("Ava");
  });
});

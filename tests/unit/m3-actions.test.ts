import { describe, expect, it } from "vitest";
import {
  parseClickParams,
  parseDownloadParams,
  parseEvaluateParams,
  parseKeyParams,
  parseActivateParams,
  parseScrollParams,
  parseSelectParams,
  parseTypeParams,
  parseUploadParams,
  parseWaitForParams,
} from "@gb-ava/protocol";

function code(result: { ok: true } | { ok: false; error: { code: string } }): string {
  return result.ok ? "ok" : result.error.code;
}

describe("action targets", () => {
  it("accepts exactly one kind of target", () => {
    expect(code(parseClickParams({ tabId: 1, selector: "#go" }))).toBe("ok");
    expect(code(parseClickParams({ tabId: 1, nodeId: 42 }))).toBe("ok");
    expect(code(parseClickParams({ tabId: 1, x: 10, y: 20 }))).toBe("ok");
    // Two kinds at once is ambiguous, not "prefer the first".
    expect(code(parseClickParams({ tabId: 1, nodeId: 42, selector: "#go" }))).toBe("invalid_request");
    expect(code(parseClickParams({ tabId: 1, selector: "#go", x: 1, y: 2 }))).toBe("invalid_request");
    expect(code(parseClickParams({ tabId: 1 }))).toBe("invalid_request");
    // Half a coordinate pair is not a point.
    expect(code(parseClickParams({ tabId: 1, x: 10 }))).toBe("invalid_request");
  });

  it("refuses a button that does not exist", () => {
    expect(code(parseClickParams({ tabId: 1, selector: "#go", button: "primary" }))).toBe("invalid_request");
    expect(code(parseClickParams({ tabId: 1, selector: "#go", button: "right" }))).toBe("ok");
  });
});

describe("typing and keys", () => {
  it("needs a target and a text value, and takes bounded text", () => {
    expect(code(parseTypeParams({ tabId: 1, selector: "#email", text: "a@b.c" }))).toBe("ok");
    expect(code(parseTypeParams({ tabId: 1, selector: "#email" }))).toBe("invalid_request");
    expect(code(parseTypeParams({ tabId: 1, selector: "#email", text: 5 }))).toBe("invalid_request");
    expect(code(parseTypeParams({ tabId: 1, selector: "#email", text: "x".repeat(20_001) }))).toBe("invalid_request");
  });

  it("carries clear and pressEnter only when they are booleans", () => {
    const parsed = parseTypeParams({ tabId: 1, selector: "#email", text: "x", clear: true, pressEnter: true });
    expect(parsed).toEqual({
      ok: true,
      value: { tabId: 1, target: { selector: "#email" }, text: "x", clear: true, pressEnter: true, inputRoute: "auto" },
    });
    expect(code(parseTypeParams({ tabId: 1, selector: "#email", text: "x", clear: "yes" }))).toBe("invalid_request");
  });

  it("accepts the three input routes and nothing else", () => {
    expect(code(parseClickParams({ tabId: 1, selector: "#a", inputRoute: "scripted" }))).toBe("ok");
    expect(code(parseClickParams({ tabId: 1, selector: "#a", inputRoute: "cdp" }))).toBe("ok");
    expect(code(parseClickParams({ tabId: 1, selector: "#a", inputRoute: "auto" }))).toBe("ok");
    expect(code(parseClickParams({ tabId: 1, selector: "#a", inputRoute: "human" }))).toBe("invalid_request");
    expect(code(parseTypeParams({ tabId: 1, selector: "#a", text: "x", inputRoute: "synthetic" }))).toBe("invalid_request");
    // Default: let the extension decide from the tab's own visibility.
    expect(code(parseClickParams({ tabId: 1, selector: "#a" }))).toBe("ok");
    expect(parseClickParams({ tabId: 1, selector: "#a" })).toMatchObject({ value: { inputRoute: "auto" } });
  });

  it("accepts only the known modifiers, once each", () => {
    expect(parseKeyParams({ tabId: 1, key: "a", modifiers: ["meta", "meta"] })).toEqual({
      ok: true,
      value: { tabId: 1, key: "a", modifiers: ["meta"] },
    });
    expect(code(parseKeyParams({ tabId: 1, key: "a", modifiers: ["hyper"] }))).toBe("invalid_request");
    expect(code(parseKeyParams({ tabId: 1, key: "a", modifiers: "meta" }))).toBe("invalid_request");
  });
});

describe("tabs.activate", () => {
  it("needs a tab id, and only raises the window when asked", () => {
    expect(parseActivateParams({ tabId: 7 })).toEqual({ ok: true, value: { tabId: 7, focusWindow: false } });
    expect(parseActivateParams({ tabId: 7, focusWindow: true })).toMatchObject({ value: { focusWindow: true } });
    expect(code(parseActivateParams({}))).toBe("invalid_request");
    expect(code(parseActivateParams({ tabId: 7, raise: true }))).toBe("invalid_request");
    expect(code(parseActivateParams({ tabId: 7, focusWindow: "yes" }))).toBe("invalid_request");
  });
});

describe("scroll, select, upload", () => {
  it("accepts a scroll with no target and requires a signed delta", () => {
    expect(code(parseScrollParams({ tabId: 1, selector: "#x", deltaY: 400 }))).toBe("ok");
    expect(code(parseScrollParams({ tabId: 1, selector: "#x", deltaY: -400 }))).toBe("ok");
    // A target is optional: without one the page's own scroller moves.
    expect(code(parseScrollParams({ tabId: 1, deltaY: 400 }))).toBe("ok");
    expect(code(parseScrollParams({ tabId: 1, deltaX: -200 }))).toBe("ok");
    // A delta is not.
    expect(code(parseScrollParams({ tabId: 1, selector: "#x" }))).toBe("invalid_request");
    expect(code(parseScrollParams({ tabId: 1 }))).toBe("invalid_request");
    expect(code(parseScrollParams({ tabId: 1, deltaY: 0, deltaX: 0 }))).toBe("invalid_request");
    expect(code(parseScrollParams({ tabId: 1, x: 10, deltaY: 100 }))).toBe("invalid_request");
  });

  it("needs a value for a select", () => {
    expect(code(parseSelectParams({ tabId: 1, selector: "#colour", value: "green" }))).toBe("ok");
    expect(code(parseSelectParams({ tabId: 1, selector: "#colour" }))).toBe("invalid_request");
  });

  it("needs at least one file and caps the list", () => {
    expect(code(parseUploadParams({ tabId: 1, selector: "#file", files: ["/tmp/a"] }))).toBe("ok");
    expect(code(parseUploadParams({ tabId: 1, selector: "#file", files: [] }))).toBe("invalid_request");
    const many = Array.from({ length: 21 }, (_, index) => `/tmp/${index}`);
    expect(code(parseUploadParams({ tabId: 1, selector: "#file", files: many }))).toBe("invalid_request");
  });
});

describe("download and waitFor", () => {
  it("bounds the download wait", () => {
    expect(code(parseDownloadParams({ tabId: 1, selector: "#dl" }))).toBe("ok");
    expect(code(parseDownloadParams({ tabId: 1, selector: "#dl", timeoutMs: 90 }))).toBe("invalid_request");
    expect(code(parseDownloadParams({ tabId: 1, selector: "#dl", timeoutMs: 60_001 }))).toBe("invalid_request");
  });

  it("needs at least one condition, and never waits without one", () => {
    expect(code(parseWaitForParams({ tabId: 1 }))).toBe("invalid_request");
    expect(code(parseWaitForParams({ tabId: 1, text: "Welcome" }))).toBe("ok");
    expect(code(parseWaitForParams({ tabId: 1, urlIncludes: "/home" }))).toBe("ok");
    expect(code(parseWaitForParams({ tabId: 1, selector: "#done", timeoutMs: 250 }))).toBe("ok");
  });
});

describe("evaluate", () => {
  it("needs an expression and defaults to not awaiting a promise", () => {
    expect(parseEvaluateParams({ tabId: 1, expression: "1+1" })).toEqual({
      ok: true,
      value: { tabId: 1, expression: "1+1", awaitPromise: false },
    });
    expect(code(parseEvaluateParams({ tabId: 1 }))).toBe("invalid_request");
    expect(code(parseEvaluateParams({ tabId: 1, expression: "" }))).toBe("invalid_request");
    expect(code(parseEvaluateParams({ tabId: 1, expression: "1", awaitPromise: "yes" }))).toBe("invalid_request");
  });
});

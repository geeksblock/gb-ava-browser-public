import { describe, expect, it } from "vitest";
import {
  TAB_GROUP_COLOR,
  TAB_GROUP_TITLE,
  isNavigableUrl,
  parseCloseParams,
  parseGroupParams,
  parseListParams,
  parseNavigateParams,
  parseQueryParams,
  parseSessionEndParams,
  parseSessionStartParams,
  parseUngroupParams,
} from "@gb-ava/protocol";

function errorOf(result: { ok: true } | { ok: false; error: { code: string } }): string {
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error.code;
}

describe("the marker contract", () => {
  it("is red and titled Ava, with no other text", () => {
    expect(TAB_GROUP_COLOR).toBe("red");
    expect(TAB_GROUP_TITLE).toBe("Ava");
  });
});

describe("tabs.list", () => {
  it("accepts no parameters and defaults a bounded limit", () => {
    expect(parseListParams(undefined)).toEqual({ ok: true, value: { limit: 50 } });
  });

  it("refuses an unknown key instead of ignoring it", () => {
    expect(errorOf(parseListParams({ tabid: 3 }))).toBe("invalid_request");
  });

  it("refuses a limit that is not an integer in range", () => {
    expect(errorOf(parseListParams({ limit: 0 }))).toBe("invalid_request");
    expect(errorOf(parseListParams({ limit: 201 }))).toBe("invalid_request");
    expect(errorOf(parseListParams({ limit: 1.5 }))).toBe("invalid_request");
  });
});

describe("tabs.query", () => {
  it("needs at least one predicate, because 'the current tab' is not a thing", () => {
    expect(errorOf(parseQueryParams(undefined))).toBe("invalid_request");
    expect(errorOf(parseQueryParams({}))).toBe("invalid_request");
  });

  it("carries predicates through and defaults the limit", () => {
    const parsed = parseQueryParams({ urlPattern: "entra", active: false });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({ urlPattern: "entra", active: false, limit: 50 });
    }
  });

  it("refuses a predicate of the wrong type", () => {
    expect(errorOf(parseQueryParams({ urlPattern: 7 }))).toBe("invalid_request");
    expect(errorOf(parseQueryParams({ active: "yes" }))).toBe("invalid_request");
  });
});

describe("tabs.navigate", () => {
  it("needs an explicit tab and an absolute navigable URL", () => {
    expect(parseNavigateParams({ tabId: 4, url: "https://example.com/login" }).ok).toBe(true);
    expect(errorOf(parseNavigateParams({ url: "https://example.com" }))).toBe("invalid_request");
    expect(errorOf(parseNavigateParams({ tabId: 4, url: "example.com" }))).toBe("invalid_request");
    expect(errorOf(parseNavigateParams({ tabId: 4, url: "chrome://settings" }))).toBe("invalid_request");
    expect(errorOf(parseNavigateParams({ tabId: -1, url: "https://example.com" }))).toBe("invalid_request");
  });

  it("knows which schemes a page can be", () => {
    expect(isNavigableUrl("https://example.com")).toBe(true);
    expect(isNavigableUrl("http://10.0.0.4")).toBe(true);
    expect(isNavigableUrl("about:blank")).toBe(true);
    expect(isNavigableUrl("file:///tmp/x.html")).toBe(true);
    // Chrome refuses a background navigation to a data: URL, so it is refused here too.
    expect(isNavigableUrl("data:text/html,<title>x</title>")).toBe(false);
    expect(isNavigableUrl("javascript:void(0)")).toBe(false);
    expect(isNavigableUrl("not a url")).toBe(false);
  });
});

describe("tabs.group and tabs.ungroup", () => {
  it("requires a non-empty, duplicate-free tab list", () => {
    expect(parseGroupParams({ tabIds: [1, 2] }).ok).toBe(true);
    expect(errorOf(parseGroupParams({ tabIds: [] }))).toBe("invalid_request");
    expect(errorOf(parseGroupParams({ tabIds: [1, 1] }))).toBe("invalid_request");
    expect(errorOf(parseGroupParams({ tabIds: ["1"] }))).toBe("invalid_request");
    expect(errorOf(parseGroupParams(undefined))).toBe("invalid_request");
  });

  it("caps the batch so one call cannot rewrite a whole browser", () => {
    const many = Array.from({ length: 101 }, (_, index) => index + 1);
    expect(errorOf(parseGroupParams({ tabIds: many }))).toBe("invalid_request");
  });

  it("ungroup takes the same shape", () => {
    expect(parseUngroupParams({ tabIds: [7] })).toEqual({ ok: true, value: { tabIds: [7] } });
    expect(errorOf(parseUngroupParams({}))).toBe("invalid_request");
  });
});

describe("tabs.close", () => {
  it("needs one tab id", () => {
    expect(parseCloseParams({ tabId: 9 })).toEqual({ ok: true, value: { tabId: 9 } });
    expect(errorOf(parseCloseParams(undefined))).toBe("invalid_request");
    expect(errorOf(parseCloseParams({ tabIds: [9] }))).toBe("invalid_request");
  });
});

describe("session.start and session.end", () => {
  it("start may name tabs or none at all", () => {
    expect(parseSessionStartParams(undefined)).toEqual({ ok: true, value: {} });
    expect(parseSessionStartParams({ tabIds: [3] })).toEqual({ ok: true, value: { tabIds: [3] } });
  });

  it("end takes no parameters and refuses anything else", () => {
    expect(parseSessionEndParams(undefined)).toEqual({ ok: true, value: {} });
    expect(errorOf(parseSessionEndParams({ ungroup: true }))).toBe("invalid_request");
  });
});

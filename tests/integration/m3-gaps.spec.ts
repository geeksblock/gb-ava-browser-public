import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  bridgeCall,
  configureViaOptionsPage,
  enableEvaluate,
  launchExtension,
  startBridge,
  startFixtureSite,
  waitForConnected,
  type BridgeHandle,
  type ExtensionHandle,
  type FixtureSite,
} from "./helpers.js";
import { startGapSite, type GapSite } from "./gap-fixtures.js";

/**
 * End-to-end gaps in the M3 surface: the flows `m3.spec.ts` does not take, driven
 * through the real bridge against real Chromium. Every assertion is about what a
 * caller sees or what the page actually did — never about an `ok: true` alone.
 */

let bridge: BridgeHandle;
let extension: ExtensionHandle;
let site: FixtureSite;
let gaps: GapSite;
let frontTab: import("@playwright/test").Page | null = null;

test.beforeEach(async () => {
  frontTab = null;
  bridge = await startBridge();
  site = await startFixtureSite();
  gaps = await startGapSite();
  extension = await launchExtension();
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);
  await waitForConnected(bridge.port);
});

test.afterEach(async () => {
  await extension?.close();
  await bridge?.stop();
  await site?.close();
  await gaps?.close();
});

interface Reply<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; retryable?: boolean; detail?: Record<string, unknown> };
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<Reply<T>> {
  return (await bridgeCall(bridge.port, bridge.token, method, params)) as unknown as Reply<T>;
}

interface TabRow {
  tabId: number;
  url: string | null;
  title: string | null;
  active: boolean;
  pinned: boolean;
  windowId: number;
  groupId: number;
}

interface ScrollReply {
  tabId: number;
  scrolled: {
    container: string;
    moved: boolean;
    before: { top: number; left: number };
    after: { top: number; left: number };
    maxScrollTop: number;
    atLimit: boolean;
  };
}

interface WaitReply {
  tabId: number;
  url: string | null;
  waitedMs: number;
  matched: { selector?: string; text?: string; urlIncludes?: string };
}

/** Open `path` in a tab, then put an unrelated tab in front. Returns the tab id. */
async function backgroundTab(path: string): Promise<number> {
  const page = await extension.context.newPage();
  await page.goto(gaps.url(path));
  return await idOf(page, path);
}

/** One tab in front for the whole test, so no other tab is ever active. */
async function bringFront(): Promise<void> {
  if (frontTab !== null && !frontTab.isClosed()) {
    await frontTab.bringToFront();
    return;
  }
  frontTab = await extension.context.newPage();
  await frontTab.goto("about:blank");
  await frontTab.bringToFront();
}

async function idOf(page: import("@playwright/test").Page, path: string): Promise<number> {
  await bringFront();
  const listed = await call<{ tabs: TabRow[] }>("tabs.list", {});
  const target = listed.result?.tabs.find((tab) => (tab.url ?? "") === gaps.origin + path);
  expect(target, `no tab at ${gaps.origin}${path}`).toBeTruthy();
  expect(target!.active).toBe(false);
  return target!.tabId;
}

async function pageOf(path: string): Promise<import("@playwright/test").Page> {
  const wanted = gaps.origin + path;
  const page = extension.context.pages().find((candidate) => candidate.url() === wanted);
  expect(page, `no Playwright handle for ${wanted}`).toBeTruthy();
  return page!;
}

async function probe(tabId: number, expression: string): Promise<unknown> {
  const reply = await call<{ value: unknown }>("page.evaluate", { tabId, expression });
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  return reply.result?.value;
}

/* ------------------------------------------------------------------ */
/* tabs.query predicates and their combinations                        */
/* ------------------------------------------------------------------ */

test("GAP: tabs.query matches url and title case-insensitively as substrings, and ANDs predicates", async () => {
  const alpha = await backgroundTab("/alpha");
  const beta = await backgroundTab("/beta");
  const login = await backgroundTab("/login");

  // Substring, case-insensitive, not a regex: ".+" must not match as a pattern.
  const literal = await call<{ count: number; tabs: TabRow[] }>("tabs.query", { titleContains: "FIXTURE-ALPHA" });
  expect(literal.ok, JSON.stringify(literal.error)).toBe(true);
  expect(literal.result?.tabs.map((tab) => tab.tabId)).toEqual([alpha]);

  const regexish = await call<{ count: number }>("tabs.query", { titleContains: "fixture-.+" });
  expect(regexish.ok).toBe(true);
  expect(regexish.result?.count).toBe(0);

  // Two predicates are ANDed, not ORed.
  const both = await call<{ count: number; tabs: TabRow[] }>("tabs.query", {
    urlPattern: gaps.origin,
    titleContains: "fixture-login",
  });
  expect(both.ok, JSON.stringify(both.error)).toBe(true);
  expect(both.result?.tabs.map((tab) => tab.tabId)).toEqual([login]);

  // active=false excludes the tab that is in front.
  const inactive = await call<{ tabs: TabRow[] }>("tabs.query", { urlPattern: gaps.origin, active: false });
  expect(inactive.ok).toBe(true);
  expect(inactive.result?.tabs.map((tab) => tab.tabId).sort()).toEqual([alpha, beta, login].sort());

  // limit caps the answer and count reports what was returned.
  const limited = await call<{ count: number; tabs: TabRow[] }>("tabs.query", { urlPattern: gaps.origin, limit: 2 });
  expect(limited.ok).toBe(true);
  expect(limited.result?.tabs.length).toBe(2);
  expect(limited.result?.count).toBe(2);

  // No predicate at all is refused (m1 pins this); an empty string IS a predicate
  // and means "matches everything", which is what a substring rule says.
  const noPredicate = await call<unknown>("tabs.query", {});
  expect(noPredicate.ok).toBe(false);
  expect(noPredicate.error?.code).toBe("invalid_request");
});

/* ------------------------------------------------------------------ */
// #33 item 2: an invalid selector must be refused, not waited out.
test("GAP: page.waitFor refuses a selector that is not valid CSS, rather than timing out", async () => {
  const tabId = await backgroundTab("/form");

  const started = Date.now();
  const bad = await call<null>("page.waitFor", { tabId, selector: "div[", timeoutMs: 5_000 });

  expect(bad.ok, "an invalid selector must not report success").toBe(false);
  // The distinction the issue is about: a caller branching on `code` can tell a
  // typo (never retry) from a slow page (`timeout`, retry).
  expect(bad.error?.code, "an invalid selector is the caller's error, not a timeout").toBe("invalid_request");
  expect(bad.error?.message).toContain("not valid CSS");
  expect(Date.now() - started, "must fail fast, not wait out the timeout").toBeLessThan(3_000);
});

/* page.waitFor: every condition, and the timeout detail               */
/* ------------------------------------------------------------------ */

test("GAP: page.waitFor answers on text and on urlIncludes, and its timeout names what it last saw", async () => {
  const tabId = await backgroundTab("/form");

  // A text condition that is already true answers without waiting out the clock.
  const started = Date.now();
  // The document says "Red"; the match is case-insensitive by contract.
  const byText = await call<WaitReply>("page.waitFor", { tabId, text: "RED", timeoutMs: 5_000 });
  expect(byText.ok, JSON.stringify(byText.error)).toBe(true);
  expect(byText.result?.matched.text).toBe("RED");
  expect(Date.now() - started, "a true condition must not wait for the timeout").toBeLessThan(3_000);

  // A urlIncludes condition answers on the current URL.
  const byUrl = await call<WaitReply>("page.waitFor", { tabId, urlIncludes: "/form", timeoutMs: 5_000 });
  expect(byUrl.ok, JSON.stringify(byUrl.error)).toBe(true);
  expect(byUrl.result?.url).toBe(gaps.origin + "/form");

  // A condition that never holds is `timeout`, and the detail says which one and
  // what was last seen — not a bare "timed out".
  const missed = await call<null>("page.waitFor", { tabId, urlIncludes: "/never-here", timeoutMs: 700 });
  expect(missed.ok).toBe(false);
  expect(missed.error?.code).toBe("timeout");
  const detail = missed.error?.detail ?? {};
  expect(JSON.stringify(detail)).toContain("/never-here");
  expect(JSON.stringify(detail)).toContain(gaps.origin + "/form");
});

test("GAP: an invalid selector in page.waitFor is a timeout carrying the error, not a silent miss", async () => {
  const tabId = await backgroundTab("/alpha");
  // `>>>` is not valid CSS. A wait that swallowed the injection error would report
  // "the element never appeared", which is a lie: the question itself was broken.
  const reply = await call<null>("page.waitFor", { tabId, selector: ">>>", timeoutMs: 600 });
  expect(reply.ok).toBe(false);
  const serialised = JSON.stringify(reply.error);
  expect(serialised, "the invalid-selector error is not surfaced anywhere").toMatch(/invalid|syntax|selector/i);
});

/* ------------------------------------------------------------------ */
/* page.scroll: both directions, the horizontal axis, and the edges    */
/* ------------------------------------------------------------------ */

test("GAP: page.scroll moves both ways on one tab and reports the edge honestly", async () => {
  // One tab for the whole walk: the positions are a sequence, and a sequence read
  // across separate tabs would be measuring different documents.
  const tabId = await backgroundTab("/scroller");

  const down = await call<ScrollReply>("page.scroll", { tabId, deltaY: 800 });
  expect(down.ok, JSON.stringify(down.error)).toBe(true);
  expect(down.result?.scrolled.before.top).toBe(0);
  expect(down.result?.scrolled.after.top).toBe(800);
  expect(down.result?.scrolled.moved).toBe(true);
  expect(down.result?.scrolled.atLimit).toBe(false);

  const up = await call<ScrollReply>("page.scroll", { tabId, deltaY: -300 });
  expect(up.ok, JSON.stringify(up.error)).toBe(true);
  expect(up.result?.scrolled.after.top).toBe(500);

  const toTop = await call<ScrollReply>("page.scroll", { tabId, deltaY: -100_000 });
  expect(toTop.ok).toBe(true);
  expect(toTop.result?.scrolled.after.top).toBe(0);
  expect(toTop.result?.scrolled.atLimit).toBe(true);

  // Past the end: a legitimate no-op, and `atLimit` says so instead of guessing.
  const pastEnd = await call<ScrollReply>("page.scroll", { tabId, deltaY: 100_000 });
  expect(pastEnd.ok, JSON.stringify(pastEnd.error)).toBe(true);
  expect(pastEnd.result?.scrolled.atLimit).toBe(true);
  expect(pastEnd.result?.scrolled.after.top).toBe(pastEnd.result?.scrolled.maxScrollTop);

  // The horizontal axis, on a page whose only horizontal scroller is a pane.
  // With no target the page's own scroller moves, and a document wider than the
  // viewport has nothing to scroll sideways; so this names the element, which is
  // the documented way to reach a pane's horizontal range.
  const sidewaysTab = await backgroundTab("/wide");
  const sideways = await call<ScrollReply>("page.scroll", { tabId: sidewaysTab, selector: "#wide-inner", deltaX: 250 });
  expect(sideways.ok, JSON.stringify(sideways.error)).toBe(true);
  expect(sideways.result?.scrolled.container).toBe("div#pane");
  expect(sideways.result?.scrolled.before.left).toBe(0);
  expect(sideways.result?.scrolled.after.left).toBe(250);
  expect(sideways.result?.scrolled.moved).toBe(true);
});

test("GAP: a second full scroll from the top lands 1600 px down, not twice the distance", async () => {
  // Each backgroundTab opens its OWN tab at /scroller. Two steps on one tab id is
  // the bug that made the first draft of this suite report 0, not a product bug.
  const tabId = await backgroundTab("/scroller");
  const first = await call<ScrollReply>("page.scroll", { tabId, deltaY: 800 });
  expect(first.ok, JSON.stringify(first.error)).toBe(true);
  const second = await call<ScrollReply>("page.scroll", { tabId, deltaY: 800 });
  expect(second.ok, JSON.stringify(second.error)).toBe(true);
  // Two 800 px scrolls from 800 must be 1600 px of travel, not 2400: a scroller
  // that applies the delta twice per call is a scroll that overshoots silently.
  expect(second.result?.scrolled.before.top).toBe(800);
  expect(second.result?.scrolled.after.top).toBe(1_600);
});

/* ------------------------------------------------------------------ */
/* page.select on a real <select>, and on things that are not one      */
/* ------------------------------------------------------------------ */

test("GAP: page.select sets a native select and fires input+change; other targets fail closed", async () => {
  const tabId = await backgroundTab("/select");
  await enableEvaluate(await extension.optionsPage(), bridge.port, bridge.token);

  const chosen = await call<{ value: string }>("page.select", { tabId, selector: "#colour", value: "green" });
  expect(chosen.ok, JSON.stringify(chosen.error)).toBe(true);
  expect(chosen.result?.value).toBe("green");

  // The page reacted: the control holds the value and both events fired once each,
  // which is what "the way a user's choice does" means.
  expect(await probe(tabId, "document.querySelector('#colour').value")).toBe("green");
  expect(await probe(tabId, "document.querySelector('#colour-value').value")).toBe("green");
  expect(await probe(tabId, "document.querySelector('#choice').value")).toBe("green");
  expect(await probe(tabId, "document.querySelector('#counts').value")).toBe("change:1,input:1");

  // An option that does not exist: `invalid_request` listing the real options.
  const missing = await call<null>("page.select", { tabId, selector: "#colour", value: "purple" });
  expect(missing.ok).toBe(false);
  expect(missing.error?.code).toBe("invalid_request");
  expect(JSON.stringify(missing.error?.detail)).toContain("green");

  // A documented gap, pinned: page.select is not routed into frames, so an element
  // inside a child frame is reported as not_found rather than silently missed.
  const framed = await backgroundTab(`/frame-host?src=${encodeURIComponent(gaps.url("/form"))}`);
  const inFrame = await call<null>("page.select", { tabId: framed, selector: "#colour", value: "green" });
  expect(inFrame.ok).toBe(false);
  expect(inFrame.error?.code).toBe("not_found");
});

test("GAP: page.select cannot select an option the control says is disabled", async () => {
  const tabId = await backgroundTab("/select");
  await enableEvaluate(await extension.optionsPage(), bridge.port, bridge.token);
  const disabled = await call<{ value: string }>("page.select", { tabId, selector: "#colour", value: "blue" });
  // The spec says a value goes in "the way a user's choice does". A user cannot
  // choose a disabled option, so the only honest answers are an error or a value
  // the control really holds.
  const held = await probe(tabId, "document.querySelector('#colour').value");
  if (disabled.ok) {
    expect(disabled.result?.value, "answered ok, but the control does not hold that value").toBe(held);
  } else {
    expect(disabled.error?.code).toBe("invalid_request");
  }
  expect(held, "a disabled option became the control's value").not.toBe("blue");
  expect(await probe(tabId, "document.querySelector('#colour-value').value")).not.toBe("blue");
});

/* ------------------------------------------------------------------ */
/* page.upload with several files                                      */
/* ------------------------------------------------------------------ */

test("GAP: page.upload attaches every file, and the page receives them in order", async () => {
  const tabId = await backgroundTab("/form");
  await enableEvaluate(await extension.optionsPage(), bridge.port, bridge.token);
  const dir = mkdtempSync(join(tmpdir(), "gb-ava-gap-upload-"));
  const first = join(dir, "one.txt");
  const second = join(dir, "two.txt");
  writeFileSync(first, "first file\n");
  writeFileSync(second, "second file\n");

  const uploaded = await call<{ count: number; files: string[] }>("page.upload", {
    tabId,
    selector: "#file",
    files: [first],
  });
  expect(uploaded.ok, JSON.stringify(uploaded.error)).toBe(true);
  expect(uploaded.result?.count).toBe(1);
  const multi = await call<{ count: number }>("page.upload", { tabId, selector: "#fileMulti", files: [first, second] });
  expect(multi.ok, JSON.stringify(multi.error)).toBe(true);
  expect(multi.result?.count).toBe(2);

  const received = await probe(
    tabId,
    "Array.from(document.querySelector('#fileMulti').files).map((f) => f.name + ':' + f.size).join('|')",
  );
  // Both files land, in the order they were given, with their real sizes.
  expect(received).toBe(`one.txt:${"first file\n".length}|two.txt:${"second file\n".length}`);
  expect(await probe(tabId, "document.querySelector('#count').textContent")).toBe("file:one.txt");

  // A path that does not exist: Chrome does NOT refuse it. Verified directly against
  // CDP — `DOM.setFileInputFiles` manufactures a zero-byte File named after the path
  // and reports no error, so the page really does receive a ghost. `count` therefore
  // cannot be zero without lying about what the input holds.
  //
  // What the reply can do is make the ghost visible: it reports what the input
  // actually holds (`attached`) and names the zero-byte entries (`empty`), so a
  // caller that expected a real file can see it did not get one.
  const absent = join(dir, "absent.txt");
  const ghost = await call<{ count: number; attached: Array<{ name: string; size: number }>; empty?: string[] }>(
    "page.upload",
    { tabId, selector: "#file", files: [absent] },
  );
  expect(ghost.ok).toBe(true);
  expect(ghost.result?.count).toBe(1);
  expect(ghost.result?.attached).toEqual([{ name: "absent.txt", size: 0 }]);
  expect(ghost.result?.empty, "a zero-byte ghost must be reported, not hidden").toEqual(["absent.txt"]);

  // A real file is not flagged as empty, so the signal is usable.
  const realAgain = await call<{ empty?: string[] }>("page.upload", { tabId, selector: "#file", files: [first] });
  expect(realAgain.ok).toBe(true);
  expect(realAgain.result?.empty).toBeUndefined();

  // A relative path is refused outright: docs/protocol.md promises absolute paths,
  // and a relative one would resolve against Chrome's cwd, not the caller's intent.
  const relative = await call<null>("page.upload", { tabId, selector: "#file", files: ["relative/file.txt"] });
  expect(relative.ok).toBe(false);
  expect(relative.error?.code).toBe("invalid_request");

  // The target is not a file input: refuse rather than answer a count.
  const notInput = await call<null>("page.upload", { tabId, selector: "#save", files: [first] });
  expect(notInput.ok).toBe(false);
});

/* ------------------------------------------------------------------ */
/* Mid-command conditions: a tab that navigates, and a tab that closes */
/* ------------------------------------------------------------------ */

test("GAP: navigating mid-command never leaves a command hanging past its own timeout", async () => {
  // The documented hazard: clicking a submit can start a navigation before the
  // synthetic mouse sequence is finished, and a renderer that swaps documents
  // stops acking. Whatever the reply, it arrives, and it says what it is.
  const tabId = await backgroundTab("/clicktest");
  const started = Date.now();
  const clicked = await call<{ queuedBehindDialog?: boolean }>("page.click", { tabId, selector: "#hit" });
  const elapsed = Date.now() - started;
  expect(elapsed, "the click never answered: a navigation mid-command hung it").toBeLessThan(20_000);
  if (!clicked.ok) {
    expect(clicked.error?.code).toBe("timeout");
    expect(JSON.stringify(clicked.error?.detail)).toContain("acked");
  }

  // Whatever happened to the tab, the next command describes the live document
  // rather than the previous one.
  await call("tabs.navigate", { tabId, url: gaps.url("/alpha") }).catch(() => undefined);
  const epochAfter = await call<{ documentEpoch: number }>("page.readAX", { tabId });
  expect(epochAfter.ok, JSON.stringify(epochAfter.error)).toBe(true);
  const before = epochAfter.result?.documentEpoch ?? 0;
  const navigated = await call("tabs.navigate", { tabId, url: gaps.url("/beta") });
  expect(navigated.ok, JSON.stringify(navigated.error)).toBe(true);
  const epochNow = await call<{ documentEpoch: number }>("page.readAX", { tabId });
  expect(epochNow.result?.documentEpoch, "a navigation did not move the document epoch").toBeGreaterThan(before);
});

test("GAP: navigating a tab that is mid-load answers promptly and the tab ends where it was asked to", async () => {
  const tabId = await backgroundTab("/alpha");
  // The fixture holds /hang open, so the tab really is in `loading` when the next
  // navigation is sent: that is a navigation mid-command, by construction.
  const first = await call("tabs.navigate", { tabId, url: gaps.url("/hang") }).catch((error: unknown) => error);
  void first; // the /hang request may still be pending; the navigate below supersedes it
  const started = Date.now();
  const second = await call<{ url: string }>("tabs.navigate", { tabId, url: gaps.url("/beta") });
  expect(second.ok, JSON.stringify(second.error)).toBe(true);
  expect(second.result?.url).toBe(gaps.url("/beta"));
  expect(Date.now() - started).toBeLessThan(12_000);
});

test("GAP: a target tab closed mid-command answers an error promptly, never a hang", async () => {
  const tabId = await backgroundTab("/scroller");
  const page = await pageOf("/scroller");
  const started = Date.now();
  const waiting = call<unknown>("page.waitFor", { tabId, selector: "#never", timeoutMs: 30_000 });
  // Close under the command rather than after it.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.close();
  const reply = await waiting;
  expect(Date.now() - started, "the wait ran for its whole timeout on a dead tab").toBeLessThan(10_000);
  expect(reply.ok).toBe(false);
  // `page.waitFor` re-reads the tab every pass and pins the exact code.
  expect(reply.error?.code).toBe("not_found");
});

test("GAP: every method refuses a closed tab id instead of answering ok", async () => {
  const tabId = await backgroundTab("/alpha");
  const page = await pageOf("/alpha");
  await page.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const [method, params] of [
    ["page.getText", { tabId }],
    ["page.readAX", { tabId }],
    ["tabs.navigate", { tabId, url: gaps.url("/beta") }],
    ["tabs.close", { tabId }],
    ["page.click", { tabId, selector: "#heading" }],
  ] as const) {
    const after = await call<unknown>(method, params as Record<string, unknown>);
    expect(after.ok, `${method} answered ok for a closed tab`).toBe(false);
    expect(["not_found", "debugger_unavailable"], `${method} on a closed tab`).toContain(after.error?.code);
    expect(`${method}: ${after.error?.message ?? ""}`).not.toMatch(/^\s*$/);
  }
  // The id stays dead: a later command does not resurrect a different tab.
  const later = await call<unknown>("tabs.navigate", { tabId, url: gaps.url("/alpha") });
  expect(later.ok).toBe(false);
  expect(later.error?.code).toBe("not_found");
});

/* ------------------------------------------------------------------ */
/* Forms: fill, validation, submit                                     */
/* ------------------------------------------------------------------ */

test("GAP: a constrained form refuses to submit until it is filled, then submits", async () => {
  const tabId = await backgroundTab("/form-validation");
  await enableEvaluate(await extension.optionsPage(), bridge.port, bridge.token);

  // Submit with nothing filled: the browser blocks the submission and marks the
  // first invalid control. The command must not pretend the form moved on.
  const early = await call("page.click", { tabId, selector: "#submitForm" });
  if (early.ok) {
    expect(await probe(tabId, "location.href")).toBe(gaps.url("/form-validation"));
    expect(await probe(tabId, "document.querySelector('#validity').textContent")).toContain("INVALID:");
  }

  // A value that violates `min` does not pass either.
  await call("page.type", { tabId, selector: "#name", text: "Ava" });
  await call("page.type", { tabId, selector: "#email", text: "ava@example.com" });
  await call("page.type", { tabId, selector: "#quantity", text: "0" });
  await call("page.click", { tabId, selector: "#submitForm" });
  expect(await probe(tabId, "location.pathname"), "quantity 0 below min submitted").toBe("/form-validation");

  await call("page.type", { tabId, selector: "#quantity", text: "3", clear: true });
  await call("page.click", { tabId, selector: "#agree" });
  const submitted = await call("page.click", { tabId, selector: "#submitForm" });
  expect(submitted.ok, JSON.stringify(submitted.error)).toBe(true);

  const landed = await call<WaitReply>("page.waitFor", { tabId, urlIncludes: "/submitted", timeoutMs: 8_000 });
  expect(landed.ok, JSON.stringify(landed.error)).toBe(true);
  // The values the caller typed are the values that were submitted.
  expect(landed.result?.url).toContain("name=Ava");
  expect(landed.result?.url).toContain("quantity=3");
  expect(landed.result?.url).toContain("agree=on");
});

/* ------------------------------------------------------------------ */
/* tabs.activate / tabs.close lifecycle                                */
/* ------------------------------------------------------------------ */

test("GAP: tabs.activate selects a tab without raising the window, and close leaves the marker consistent", async () => {
  const first = await backgroundTab("/alpha");
  const second = await backgroundTab("/beta");

  const started = await call<{ marker: { group: { color: string; title: string } | null } }>("session.start", {
    tabIds: [first, second],
  });
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  expect(started.result?.marker.group?.color).toBe("red");

  const activated = await call<{ activated: boolean; wasActive: boolean; windowRaised: boolean; windowFocused: boolean }>(
    "tabs.activate",
    { tabId: first },
  );
  expect(activated.ok, JSON.stringify(activated.error)).toBe(true);
  expect(activated.result?.activated).toBe(true);
  expect(activated.result?.wasActive).toBe(false);
  expect(activated.result?.windowRaised).toBe(false);
  const listed = await call<{ tabs: TabRow[] }>("tabs.list", {});
  expect(listed.result?.tabs.find((tab) => tab.tabId === first)?.active).toBe(true);
  expect(listed.result?.tabs.find((tab) => tab.tabId === second)?.active).toBe(false);

  // Activating again reports it was already active, so a caller can tell it did
  // not move the owner's view.
  const again = await call<{ wasActive: boolean }>("tabs.activate", { tabId: first });
  expect(again.result?.wasActive).toBe(true);

  // Closing the active marked tab moves the active flag to a remaining tab and
  // leaves the marker holding the survivor only.
  const closed = await call<{ closedTabId: number; marker: { tabIds: number[] } }>("tabs.close", { tabId: first });
  expect(closed.ok, JSON.stringify(closed.error)).toBe(true);
  expect(closed.result?.marker.tabIds).toEqual([second]);
  const after = await call<{ tabs: TabRow[] }>("tabs.list", {});
  expect(after.result?.tabs.some((tab) => tab.tabId === first)).toBe(false);
  expect(after.result?.tabs.filter((tab) => tab.active).length).toBe(1);
});

test("GAP: tabs.close on the last marked tab empties the marker and ungroups nothing else", async () => {
  const tabId = await backgroundTab("/alpha");
  await bringFront();
  const other = await backgroundTab("/beta");
  await call("session.start", { tabIds: [tabId] });
  const closed = await call<{ marker: { tabIds: number[]; group: unknown } }>("tabs.close", { tabId });
  expect(closed.ok, JSON.stringify(closed.error)).toBe(true);
  expect(closed.result?.marker.tabIds).toEqual([]);
  expect(closed.result?.marker.group).toBeNull();
  const rows = await call<{ tabs: TabRow[] }>("tabs.list", {});
  expect(rows.result?.tabs.find((row) => row.tabId === other)?.groupId).toBe(-1);
});

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

test("GAP: a second command on a busy tab is refused with tab_busy, and the tab recovers", async () => {
  const tabId = await backgroundTab("/alpha");
  const waiting = call<unknown>("page.waitFor", { tabId, selector: "#never", timeoutMs: 3_000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const busy = await call<unknown>("page.getText", { tabId });
  expect(busy.ok, "two commands interleaved on one tab").toBe(false);
  expect(busy.error?.code).toBe("tab_busy");
  expect(busy.error?.retryable).toBe(true);
  await waiting;
  const recovered = await call<{ text: string }>("page.getText", { tabId });
  expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
});

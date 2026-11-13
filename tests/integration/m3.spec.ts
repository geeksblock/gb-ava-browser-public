import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  bridgeCall,
  bridgeHealth,
  configureViaOptionsPage,
  enableEvaluate,
  launchExtension,
  waitForNoDialog,
  startBridge,
  startFixtureSite,
  waitForConnected,
  type BridgeHandle,
  type ExtensionHandle,
  type FixtureSite,
} from "./helpers.js";

/**
 * M3 acceptance (issue #5): act on a tab that is not in front. The issue's own
 * acceptance is a real Microsoft Entra sign-in with a Temporary Access Pass; the
 * suite reproduces that shape (identifier step, code step, redirect) on the
 * fixture site so it can run offline, and the same flow against a real tenant is
 * a manual check documented in the runbook.
 */

let bridge: BridgeHandle;
let extension: ExtensionHandle;
let site: FixtureSite;

test.beforeEach(async () => {
  bridge = await startBridge();
  site = await startFixtureSite();
  extension = await launchExtension();
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);
  await waitForConnected(bridge.port);
});

test.afterEach(async () => {
  await extension?.close();
  await bridge?.stop();
  await site?.close();
});

interface Reply<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<Reply<T>> {
  return (await bridgeCall(bridge.port, bridge.token, method, params)) as unknown as Reply<T>;
}

interface TabRow {
  tabId: number;
  url: string | null;
  active: boolean;
}

async function backgroundTab(path: string): Promise<number> {
  const page = await extension.context.newPage();
  await page.goto(site.url(path));
  const front = await extension.context.newPage();
  await front.goto("about:blank");
  await front.bringToFront();
  const reply = await call<{ tabs: TabRow[] }>("tabs.list", {});
  const target = reply.result?.tabs.find((tab) => tab.url === site.url(path));
  expect(target, `no tab at ${site.url(path)}`).toBeTruthy();
  expect(target!.active).toBe(false);
  return target!.tabId;
}

async function nodeFor(tabId: number, selector: string): Promise<number> {
  // A selector is resolved through the accessibility tree so the test uses the
  // same handle an agent would (and proves the ids from readAX are clickable).
  const read = await call<{ nodes: Array<{ nodeId: number | null; role: string; name: string }> }>("page.readAX", {
    tabId,
    includeInvisible: true,
    limit: 4000,
  });
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  const wanted = selector;
  const match = (read.result?.nodes ?? []).find((node) => node.name.includes(wanted));
  expect(match?.nodeId, `no AX node named like ${wanted}`).toBeTruthy();
  return match!.nodeId!;
}

test("M3: the sign-in flow completes on a background tab", async () => {
  const tabId = await backgroundTab("/signin");

  const email = await call<{ value: string | null }>("page.readAX", { tabId, includeInvisible: false });
  expect(email.ok).toBe(true);

  // Identifier step: type the address, press Enter.
  const typed = await call<{ typed: number }>("page.type", {
    tabId,
    selector: "#email",
    text: "ava@example.com",
    pressEnter: true,
  });
  expect(typed.ok, JSON.stringify(typed.error)).toBe(true);

  // The second step only exists after the first submitted.
  const waited = await call<{ waitedMs: number }>("page.waitFor", { tabId, selector: "#code", timeoutMs: 8_000 });
  expect(waited.ok, JSON.stringify(waited.error)).toBe(true);

  const code = await call<{ typed: number }>("page.type", {
    tabId,
    selector: "#code",
    text: "123456789",
    pressEnter: true,
  });
  expect(code.ok).toBe(true);

  const redirected = await call<{ url: string | null }>("page.waitFor", {
    tabId,
    urlIncludes: "/done",
    timeoutMs: 8_000,
  });
  expect(redirected.ok, JSON.stringify(redirected.error)).toBe(true);
  expect(redirected.result?.url).toBe(site.url("/done"));

  const text = await call<{ text: string }>("page.getText", { tabId });
  expect(text.result?.text).toContain("signed in");

  // The whole flow happened on a tab that was never brought forward.
  const tabs = await call<{ tabs: TabRow[] }>("tabs.list", {});
  expect(tabs.result?.tabs.find((tab) => tab.tabId === tabId)?.active).toBe(false);
});

test("M3: an AX node id from readAX is clickable, and a selector works too", async () => {
  const tabId = await backgroundTab("/form");

  const read = await call<{ nodes: Array<{ nodeId: number | null; role: string; name: string }> }>("page.readAX", {
    tabId,
    includeInvisible: true,
    limit: 4000,
  });
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  const later = (read.result?.nodes ?? []).find((node) => node.role === "button" && node.name.includes("Later"));
  expect(later?.nodeId).toBeTruthy();

  const clicked = await call<{ clicked: { x: number; y: number } }>("page.click", { tabId, nodeId: later!.nodeId });
  expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true);
  expect(clicked.result?.clicked.x).toBeGreaterThan(0);

  // The click had its effect: the node appears 600 ms later, so waitFor proves it.
  const appeared = await call<{ matched: unknown }>("page.waitFor", { tabId, selector: "#late-text", timeoutMs: 5_000 });
  expect(appeared.ok, JSON.stringify(appeared.error)).toBe(true);

  // A selector target works as well.
  const bySelector = await call<{ clicked: { x: number; y: number } }>("page.click", { tabId, selector: "#save" });
  expect(bySelector.ok).toBe(true);

  // A target that matches nothing is `not_found`, and a bad one is refused.
  const missing = await call<unknown>("page.click", { tabId, selector: "#nope" });
  expect(missing.ok).toBe(false);
  expect(missing.error?.code).toBe("not_found");

  const both = await call<unknown>("page.click", { tabId, selector: "#save", nodeId: 5 });
  expect(both.ok).toBe(false);
  expect(both.error?.code).toBe("invalid_request");
});

test("M3: select, upload, scroll and key act without focus", async () => {
  const tabId = await backgroundTab("/form");

  const selected = await call<{ value: string }>("page.select", { tabId, selector: "#colour", value: "green" });
  expect(selected.ok, JSON.stringify(selected.error)).toBe(true);
  expect(selected.result?.value).toBe("green");

  const dir = mkdtempSync(join(tmpdir(), "gb-ava-upload-"));
  const file = join(dir, "note.txt");
  writeFileSync(file, "hello from the test\n");
  const uploaded = await call<{ count: number }>("page.upload", { tabId, selector: "#file", files: [file] });
  expect(uploaded.ok, JSON.stringify(uploaded.error)).toBe(true);
  expect(uploaded.result?.count).toBe(1);

  // A hidden input is the common upload pattern (a styled label over display:none)
  // and has no box at all.
  const hidden = await call<{ count: number }>("page.upload", { tabId, selector: "#hiddenFile", files: [file] });
  expect(hidden.ok, JSON.stringify(hidden.error)).toBe(true);

  // The page really received the file, not just the protocol.
  const gate = await call<unknown>("page.evaluate", { tabId, expression: "1" });
  expect(gate.ok).toBe(false); // gated: off by default
  expect(gate.error?.code).toBe("evaluate_disabled");

  const options = await extension.optionsPage();
  await enableEvaluate(options, bridge.port, bridge.token);
  const received = await call<{ value: string }>("page.evaluate", {
    tabId,
    expression: "document.querySelector('#file').files[0].name + '|' + document.querySelector('#hiddenFile').files[0].name",
  });
  expect(received.ok, JSON.stringify(received.error)).toBe(true);
  expect(received.result?.value).toBe("note.txt|note.txt");

  const scrolled = await call<{ scrolled: { container: string } }>("page.scroll", { tabId, selector: "#save", deltaY: 400 });
  expect(scrolled.ok, JSON.stringify(scrolled.error)).toBe(true);
  expect(scrolled.result?.scrolled.container).toBeTruthy();

  const key = await call<{ key: string }>("page.key", { tabId, key: "Tab" });
  expect(key.ok, JSON.stringify(key.error)).toBe(true);

  // An unknown key is refused rather than silently ignored.
  const badKey = await call<unknown>("page.key", { tabId, key: "F13" });
  expect(badKey.ok).toBe(false);

  const tabs = await call<{ tabs: TabRow[] }>("tabs.list", {});
  expect(tabs.result?.tabs.find((tab) => tab.tabId === tabId)?.active).toBe(false);
});

test("M3: a click lands on a background tab and says which route ran", async () => {
  // Issue #16: every mouse-input method timed out on a tab that had been in the
  // background — Chrome does not ack Input.dispatchMouseEvent for a renderer it is
  // not compositing — while keyboard input to the same tab worked. A click that
  // answers `ok` is not the assertion; the page reacting is.
  const tabId = await backgroundTab("/clicktest");

  const clicked = await call<{ input: { route: string; reason: string }; clicked: { x: number; y: number } }>("page.click", {
    tabId,
    selector: "#hit",
  });
  expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true);
  // The tab is not in front, so the route has to be the in-page one.
  expect(clicked.result?.input.route).toBe("scripted");
  expect(clicked.result?.input.reason).toBeTruthy();

  const after = await call<{ text: string }>("page.getText", { tabId });
  expect(after.result?.text).toContain("clicked");
});

test("M3: a click on the tab in front still uses real browser input", async () => {
  // The other half of the routing rule: when the tab really is in front, the click
  // goes through Chrome's own input pipeline rather than the page.
  const page = await extension.context.newPage();
  await page.goto(site.url("/clicktest"));
  await page.bringToFront();
  const tabs = await call<{ tabs: TabRow[] }>("tabs.list", {});
  const tabId = tabs.result?.tabs.find((tab) => tab.url === site.url("/clicktest"))?.tabId;
  expect(tabId).toBeTruthy();

  const clicked = await call<{ input: { route: string } }>("page.click", { tabId: tabId!, selector: "#hit" });
  expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true);
  expect(clicked.result?.input.route).toBe("cdp");

  const after = await call<{ text: string }>("page.getText", { tabId: tabId! });
  expect(after.result?.text).toContain("clicked");
});

test("M3: page.scroll moves the page with no target and a nested scroller by node", async () => {
  // Issue #19: scroll needed a target, and the two routes it had were a wheel
  // event (dead on a background tab) and keyboard paging (focus-dependent).
  const tabId = await backgroundTab("/scroller");

  const page = await call<{ scrolled: { container: string; moved: boolean; after: { top: number } } }>("page.scroll", {
    tabId,
    deltaY: 600,
  });
  expect(page.ok, JSON.stringify(page.error)).toBe(true);
  expect(page.result?.scrolled.container).toBe("document");
  expect(page.result?.scrolled.moved).toBe(true);
  expect(page.result?.scrolled.after.top).toBeGreaterThan(0);

  // The nested container is a different scroller, and naming the node inside it
  // picks that one rather than the document.
  const inner = await call<{ scrolled: { container: string; moved: boolean; after: { top: number } } }>("page.scroll", {
    tabId,
    selector: "#inner",
    deltaY: 300,
  });
  expect(inner.ok, JSON.stringify(inner.error)).toBe(true);
  expect(inner.result?.scrolled.container).toBe("div#inner");
  expect(inner.result?.scrolled.moved).toBe(true);
  expect(inner.result?.scrolled.after.top).toBeGreaterThan(0);

  // A delta is still required: scrolling by nothing is a caller mistake.
  const noDelta = await call<unknown>("page.scroll", { tabId });
  expect(noDelta.ok).toBe(false);
});

test("M3: typing with clear replaces the value instead of appending", async () => {
  const tabId = await backgroundTab("/signin");
  const options = await extension.optionsPage();
  await enableEvaluate(options, bridge.port, bridge.token);

  await call("page.type", { tabId, selector: "#email", text: "first@example.com" });
  const replaced = await call("page.type", {
    tabId,
    selector: "#email",
    text: "second@example.com",
    clear: true,
  });
  expect(replaced.ok, JSON.stringify(replaced.error)).toBe(true);

  const value = await call<{ value: string }>("page.evaluate", {
    tabId,
    expression: "document.querySelector('#email').value",
  });
  expect(value.result?.value).toBe("second@example.com");
});

test("M3: a dialog in one tab does not block another tab", async () => {
  const blockedTab = await backgroundTab("/form");
  const otherTab = await backgroundTab("/alpha");

  const page = extension.context.pages().find((candidate) => candidate.url() === site.url("/form"));
  const held: { dialog?: unknown } = {};
  const opened = new Promise<void>((resolve) => {
    page!.once("dialog", (dialog) => {
      held.dialog = dialog;
      resolve();
    });
  });

  const clicked = await call<{ needsHuman: { reason: string } | null }>("page.click", {
    tabId: blockedTab,
    selector: "#alertButton",
  });
  expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true);
  expect(clicked.result?.needsHuman?.reason).toBe("javascript_dialog");
  await opened;

  // The other tab is unaffected: dialog state is per tab, not global.
  const otherRead = await call<{ nodes: unknown[] }>("page.readAX", { tabId: otherTab });
  expect(otherRead.ok, JSON.stringify(otherRead.error)).toBe(true);

  // …while the tab with the dialog still refuses.
  const stillBlocked = await call<unknown>("page.click", { tabId: blockedTab, selector: "#save" });
  expect(stillBlocked.ok).toBe(false);
  expect(stillBlocked.error?.code).toBe("needs_human");

  // Dismiss it and the tab recovers. The worker learns it closed from a CDP event,
  // so wait for that rather than racing it with the next click.
  await (held.dialog as { dismiss(): Promise<void> }).dismiss();
  await waitForNoDialog(bridge.port, bridge.token, blockedTab, 5_000);
  const recovered = await call<unknown>("page.click", { tabId: blockedTab, selector: "#save" });
  expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
});

test("M3: a wait longer than the bridge's default is left to the method", async () => {
  const tabId = await backgroundTab("/alpha");
  // The bridge's default request timeout is 10 s; page.waitFor is allowed 65 s so
  // the caller gets the method's own timeout with its last-seen detail instead of
  // the bridge's bare one.
  const started = Date.now();
  const reply = await call<unknown>("page.waitFor", { tabId, selector: "#never", timeoutMs: 12_000 });
  const elapsed = Date.now() - started;
  expect(reply.ok).toBe(false);
  expect(reply.error?.code).toBe("timeout");
  expect(elapsed).toBeGreaterThan(11_000);
  expect(JSON.stringify(reply.error)).toContain("lastSeen");
});

test("M3: a click that starts a download reports the download", async () => {
  const tabId = await backgroundTab("/form");
  const reply = await call<{ download: { filename: string; state: string; finalUrl: string } }>("page.download", {
    tabId,
    selector: "#dlink",
    timeoutMs: 8_000,
  });
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  // Chrome resolves the target path asynchronously; `finalUrl` identifies the
  // download even when `filename` is not yet known, and the test asserts both.
  expect(reply.result?.download.finalUrl).toContain("/download.txt");
  expect(["in_progress", "complete"]).toContain(reply.result?.download.state ?? "");
});

test("M3: a JavaScript dialog is reported as needs_human, not waited out", async () => {
  const tabId = await backgroundTab("/form");

  // Holding the dialog open is what a real user experiences; Playwright would
  // otherwise dismiss it for us, hiding the condition we want to test.
  const page = extension.context.pages().find((candidate) => candidate.url() === site.url("/form"));
  expect(page).toBeTruthy();
  // Holding the dialog is what a human sees. Playwright only leaves a dialog open
  // when a listener is attached, so this listener stores it and does nothing.
  const held: { dialog?: unknown } = {};
  const dialogSeen = new Promise<void>((resolve) => {
    page!.once("dialog", (dialog) => {
      held.dialog = dialog;
      resolve();
    });
  });

  const clicked = await call<{ needsHuman: { reason: string } | null }>("page.click", { tabId, selector: "#alertButton" });
  expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true);
  expect(clicked.result?.needsHuman?.reason).toBe("javascript_dialog");

  // While it is open, the next command says so instead of hanging.
  const blocked = await call<unknown>("page.click", { tabId, selector: "#save" });
  expect(blocked.ok).toBe(false);
  expect(blocked.error?.code).toBe("needs_human");

  await dialogSeen;
  await (held.dialog as unknown as { dismiss(): Promise<void> }).dismiss();
  await waitForNoDialog(bridge.port, bridge.token, tabId);
  // Once a human dismisses it, the tab accepts commands again.
  const after = await call<unknown>("page.click", { tabId, selector: "#save" });
  expect(after.ok).toBe(true);
});

test("M3: page.evaluate stays off until a human turns it on", async () => {
  const tabId = await backgroundTab("/form");

  const off = await call<unknown>("page.evaluate", { tabId, expression: "document.title" });
  expect(off.ok).toBe(false);
  expect(off.error?.code).toBe("evaluate_disabled");

  const options = await extension.optionsPage();
  await options.check("#evaluate-enabled");

  const on = await call<{ value: string }>("page.evaluate", { tabId, expression: "document.title" });
  expect(on.ok, JSON.stringify(on.error)).toBe(true);
  expect(on.result?.value).toBe("fixture-form");

  // A thrown expression is an error, never a null result.
  const thrown = await call<unknown>("page.evaluate", { tabId, expression: "throw new Error('boom')" });
  expect(thrown.ok).toBe(false);
});

test("M3: a download link and a scroll inside a frame are reached, and an ambiguous selector fails closed", async () => {
  const child = await startFixtureSite();
  const other = await startFixtureSite();
  try {
    // Download and scroll inside a cross-origin frame.
    const page = await extension.context.newPage();
    await page.goto(`${site.url("/frame-host")}?src=${encodeURIComponent(child.url("/form"))}`);
    await page.waitForSelector("#child");
    const front = await extension.context.newPage();
    await front.goto("about:blank");
    await front.bringToFront();
    const tabId = (await call<{ tabs: TabRow[] }>("tabs.list", {})).result!.tabs.find((tab) =>
      (tab.url ?? "").startsWith(site.url("/frame-host")),
    )!.tabId;

    const downloaded = await call<{ download: { finalUrl: string; state: string } }>("page.download", {
      tabId,
      selector: "#dlink",
      timeoutMs: 8_000,
    });
    expect(downloaded.ok, JSON.stringify(downloaded.error)).toBe(true);
    expect(downloaded.result?.download.finalUrl).toContain("download.txt");

    const scrolled = await call<{ scrolled: { container: string; moved: boolean; deltaY: number } }>("page.scroll", {
      tabId,
      selector: "#colour",
      deltaY: 200,
    });
    expect(scrolled.ok, JSON.stringify(scrolled.error)).toBe(true);
    // Same reply shape as the top-document route, not an `ok` wrapping a failure.
    expect(scrolled.result?.scrolled.deltaY).toBe(200);
    expect(scrolled.result?.scrolled.container).toBeTruthy();

    // The same selector in two frames is ambiguous: refuse rather than guess.
    await page.goto(
      `${site.url("/frame-host")}?src=${encodeURIComponent(child.url("/clicktest"))}&src2=${encodeURIComponent(other.url("/clicktest"))}`,
    );
    await page.waitForSelector("#child2");
    const ambiguous = await call<unknown>("page.click", { tabId, selector: "#hit" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error?.code).toBe("invalid_request");
    expect(ambiguous.error?.message).toContain("frames");
  } finally {
    await child.close();
    await other.close();
  }
});

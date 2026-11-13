import { expect, test } from "@playwright/test";
import {
  bridgeCall,
  bridgeHealth,
  configureViaOptionsPage,
  launchExtension,
  occludeBrowser,
  startBridge,
  startFixtureSite,
  waitForConnected,
  type BridgeHandle,
  type ExtensionHandle,
  type FixtureSite,
} from "./helpers.js";

/**
 * M2 acceptance (issue #4): read a tab that is **not** in front, with Chrome
 * occluded. This is the product thesis, so the tests put another tab in front and
 * then read the background one through the bridge.
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

interface TabRow {
  tabId: number;
  url: string | null;
  active: boolean;
}

async function listTabs(): Promise<TabRow[]> {
  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.list", {})) as unknown as {
    result?: { tabs: TabRow[] };
  };
  return reply.result?.tabs ?? [];
}

/** Open the page under test and then put a *different* tab in front of it. */
async function backgroundTab(path: string): Promise<number> {
  const page = await extension.context.newPage();
  await page.goto(site.url(path));
  const front = await extension.context.newPage();
  await front.goto("about:blank");
  await front.bringToFront();
  const tabs = await listTabs();
  const target = tabs.find((tab) => tab.url === site.url(path));
  expect(target, `no tab at ${site.url(path)}`).toBeTruthy();
  expect(target!.active).toBe(false);
  return target!.tabId;
}

test("M2: readAX returns the accessibility tree of a background tab", async () => {
  const tabId = await backgroundTab("/login");

  const reply = (await bridgeCall(bridge.port, bridge.token, "page.readAX", { tabId })) as unknown as {
    ok: boolean;
    result?: {
      nodes: Array<{ role: string; name: string; nodeId: number | null; bounds: unknown }>;
      source: string;
      truncated: boolean;
      totalNodes: number;
      title: string | null;
    };
    error?: { code: string; message: string };
  };
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  expect(reply.result?.source).toBe("debugger");
  expect(reply.result?.title).toBe("fixture-login");

  const nodes = reply.result?.nodes ?? [];
  const roles = nodes.map((entry) => entry.role);
  expect(roles).toContain("textbox");
  expect(roles).toContain("button");
  expect(nodes.find((entry) => entry.role === "button")?.name).toContain("Sign in");
  // A backend node id is what page.click will address in M3.
  expect(nodes.some((entry) => typeof entry.nodeId === "number")).toBe(true);

  // The read happened on a tab that was not in front, and did not bring it there.
  const tabs = await listTabs();
  expect(tabs.find((tab) => tab.tabId === tabId)?.active).toBe(false);

  const health = await bridgeHealth(bridge.port);
  const debuggerSessions = (health.extension.connected ? (health.extension.health as Record<string, unknown>) : {})[
    "debugger"
  ] as { attached: Array<{ tabId: number }> };
  expect(debuggerSessions.attached.some((session) => session.tabId === tabId)).toBe(true);
});

test("M2: reads still work with another application frontmost", async () => {
  const tabId = await backgroundTab("/login");
  const occluded = await occludeBrowser();

  const ax = (await bridgeCall(bridge.port, bridge.token, "page.readAX", { tabId })) as unknown as {
    ok: boolean;
    result?: { nodes: Array<{ role: string }>; source: string };
    error?: { code: string; message: string };
  };
  expect(ax.ok, JSON.stringify(ax.error)).toBe(true);
  expect(ax.result?.nodes.some((entry) => entry.role === "textbox")).toBe(true);

  const shot = (await bridgeCall(bridge.port, bridge.token, "page.screenshot", { tabId })) as unknown as {
    ok: boolean;
    result?: { png: string; width: number | null };
  };
  expect(shot.ok).toBe(true);
  expect(shot.result?.png.startsWith("iVBORw0KGgo")).toBe(true);
  expect(shot.result?.width).toBeGreaterThan(0);

  // Recorded so a reader knows whether this run proved the occluded case.
  test.info().annotations.push({ type: "occluded", description: String(occluded) });
});

test("M2: getText returns the rendered text of a background tab without the debugger", async () => {
  const tabId = await backgroundTab("/login");

  const reply = (await bridgeCall(bridge.port, bridge.token, "page.getText", { tabId })) as unknown as {
    ok: boolean;
    result?: { text: string; source: string; truncated: boolean; length: number };
    error?: { code: string };
  };
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  expect(reply.result?.source).toBe("scripting");
  expect(reply.result?.text).toContain("Sign in");
  expect(reply.result?.truncated).toBe(false);

  // A small limit is honoured and reported.
  const limited = (await bridgeCall(bridge.port, bridge.token, "page.getText", { tabId, limit: 5 })) as unknown as {
    result?: { truncated: boolean; text: string };
  };
  expect(limited.result?.truncated).toBe(true);
  expect(limited.result?.text).toContain("truncated");
});

test("M2: reads see content inside an iframe, and say which frames were read", async () => {
  // Issue #17: Microsoft admin portals render every blade in an iframe. readAX and
  // getText returned only the outer shell — silently, with `truncated: false` — so
  // the only route to the answer was a screenshot. The second origin makes the
  // child frame cross-origin, which is the out-of-process case that defeated the
  // single CDP session in the report.
  const child = await startFixtureSite();
  try {
    const page = await extension.context.newPage();
    await page.goto(`${site.url("/frame-host")}?src=${encodeURIComponent(child.url("/clicktest"))}`);
    await page.waitForSelector("#child");
    const front = await extension.context.newPage();
    await front.goto("about:blank");
    await front.bringToFront();

    const tabs = await listTabs();
    const target = tabs.find((tab) => (tab.url ?? "").startsWith(site.url("/frame-host")));
    expect(target, "no frame-host tab").toBeTruthy();
    const tabId = target!.tabId;

    const text = (await bridgeCall(bridge.port, bridge.token, "page.getText", { tabId })) as unknown as {
      ok: boolean;
      result?: { text: string; frames?: Array<{ url: string | null; read: boolean }> };
      error?: { code: string };
    };
    expect(text.ok, JSON.stringify(text.error)).toBe(true);
    // The shell and the framed content, from one read.
    expect(text.result?.text).toContain("frame host");
    expect(text.result?.text).toContain("clicktest");
    // The reply names the frames, so a caller knows where the content came from.
    expect(text.result?.frames?.some((frame) => (frame.url ?? "").includes(child.origin))).toBe(true);

    const ax = (await bridgeCall(bridge.port, bridge.token, "page.readAX", {
      tabId,
      includeInvisible: true,
      limit: 4000,
    })) as unknown as {
      ok: boolean;
      result?: { nodes: Array<{ name: string; frame?: number | null }>; framesNotRead?: string[]; totalNodes: number };
      error?: { code: string };
    };
    expect(ax.ok, JSON.stringify(ax.error)).toBe(true);
    expect(ax.result?.nodes.some((node) => node.name === "Hit")).toBe(true);
    // Nothing was silently dropped: either every frame was read or the ones that
    // were not are named.
    expect(ax.result?.framesNotRead ?? []).toEqual([]);

    // And the framed content is actionable: click it by selector across frames.
    const heading = (await bridgeCall(bridge.port, bridge.token, "page.readAX", {
      tabId,
      includeInvisible: false,
      limit: 4000,
    })) as unknown as { result?: { nodes: Array<{ name: string; selector?: string | null }> } };
    const framed = heading.result?.nodes.find((node) => node.name === "Hit");
    expect(framed?.selector, "a node read from a frame must carry a selector to address it").toBeTruthy();

    // Clicking that selector reaches into the frame: the framed page must react.
    const clicked = (await bridgeCall(bridge.port, bridge.token, "page.click", {
      tabId,
      selector: framed!.selector,
    })) as unknown as { ok: boolean; result?: { input: { route: string }; frame?: string }; error?: { code: string } };
    expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true);
    expect(clicked.result?.input.route).toBe("frame");

    const after = (await bridgeCall(bridge.port, bridge.token, "page.getText", { tabId })) as unknown as {
      result?: { text: string };
    };
    expect(after.result?.text).toContain("clicked");
  } finally {
    await child.close();
  }
});

test("M2: typing into a field inside an iframe reaches the field", async () => {
  const child = await startFixtureSite();
  try {
    const page = await extension.context.newPage();
    await page.goto(`${site.url("/frame-host")}?src=${encodeURIComponent(child.url("/login"))}`);
    await page.waitForSelector("#child");
    const front = await extension.context.newPage();
    await front.goto("about:blank");
    await front.bringToFront();

    const tabs = await listTabs();
    const tabId = tabs.find((tab) => (tab.url ?? "").startsWith(site.url("/frame-host")))!.tabId;

    const typed = (await bridgeCall(bridge.port, bridge.token, "page.type", {
      tabId,
      selector: "#email",
      text: "ava@example.com",
    })) as unknown as { ok: boolean; result?: { input: { route: string } }; error?: { code: string; message?: string } };
    expect(typed.ok, JSON.stringify(typed.error)).toBe(true);
    expect(typed.result?.input.route).toBe("frame");

    // The framed field carries the value: read it back through the frame read.
    const read = (await bridgeCall(bridge.port, bridge.token, "page.readAX", { tabId, limit: 2000 })) as unknown as {
      result?: { nodes: Array<{ selector?: string | null; value: string | null }> };
    };
    const field = read.result?.nodes.find((node) => node.selector === "#email");
    expect(field?.value).toBe("ava@example.com");
  } finally {
    await child.close();
  }
});

test("M2: screenshot returns a PNG of the background tab itself", async () => {
  const tabId = await backgroundTab("/login");

  const reply = (await bridgeCall(bridge.port, bridge.token, "page.screenshot", { tabId })) as unknown as {
    ok: boolean;
    result?: { png: string; width: number | null; height: number | null; bytes: number; possiblyStale: boolean };
    error?: { code: string; message: string };
  };
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  const png = reply.result?.png ?? "";
  expect(png.startsWith("iVBORw0KGgo")).toBe(true);
  expect(reply.result?.width).toBeGreaterThan(0);
  expect(reply.result?.height).toBeGreaterThan(0);
  expect(reply.result?.bytes).toBeGreaterThan(0);

  // The tab is still in the background.
  const tabs = await listTabs();
  expect(tabs.find((tab) => tab.tabId === tabId)?.active).toBe(false);
});

test("M2: a stale capture is reported rather than presented as fresh", async () => {
  const tabId = await backgroundTab("/login");

  const first = (await bridgeCall(bridge.port, bridge.token, "page.screenshot", { tabId })) as unknown as {
    result?: { png: string };
  };
  expect(first.result?.png).toBeTruthy();

  // Change the page while it is still in the background, then capture again and
  // ask for the staleness verdict. Whether Chrome recomposited or not, the answer
  // must be consistent: identical bytes must be flagged, changed bytes must not.
  const page = extension.context.pages().find((candidate) => candidate.url() === site.url("/login"));
  expect(page).toBeTruthy();
  await page!.evaluate(() => {
    document.body.style.background = "#ff0000";
    const heading = document.createElement("h2");
    heading.id = "probe";
    heading.textContent = "changed";
    document.body.appendChild(heading);
  });

  const second = (await bridgeCall(bridge.port, bridge.token, "page.screenshot", {
    tabId,
    detectStale: true,
  })) as unknown as { result?: { png: string; possiblyStale: boolean } };

  const identical = second.result?.png === first.result?.png;
  expect(second.result?.possiblyStale).toBe(identical);

  // The other half of the mechanism: a capture with no change in between is
  // byte-identical, and must be reported rather than presented as fresh.
  const beforeIdle = (await bridgeCall(bridge.port, bridge.token, "page.screenshot", {
    tabId,
    detectStale: true,
  })) as unknown as { result?: { png: string; possiblyStale: boolean } };
  const idleAgain = (await bridgeCall(bridge.port, bridge.token, "page.screenshot", {
    tabId,
    detectStale: true,
  })) as unknown as { result?: { png: string; possiblyStale: boolean } };
  if (idleAgain.result?.png === beforeIdle.result?.png) {
    expect(idleAgain.result?.possiblyStale).toBe(true);
  }

  // And a fresh capture of an in-front tab is never flagged.
  await page!.bringToFront();
  await page!.evaluate(() => {
    document.body.style.background = "#00ff00";
  });
  const visible = (await bridgeCall(bridge.port, bridge.token, "page.screenshot", {
    tabId,
    detectStale: true,
  })) as unknown as { result?: { possiblyStale: boolean; png: string } };
  expect(visible.result?.png).not.toBe(second.result?.png);
  expect(visible.result?.possiblyStale).toBe(false);
});

test("M2: when another debugger owns the tab, readAX degrades and says so", async () => {
  const tabId = await backgroundTab("/login");

  // Chrome allows exactly one debugger per target, which is why a tab with DevTools
  // open cannot be attached. Taking the session from the extension's own page puts
  // the worker in exactly that position, deterministically.
  const page = await extension.optionsPage();
  await page.evaluate((id) => chrome.debugger.attach({ tabId: id }, "1.3"), tabId);

  const reply = (await bridgeCall(bridge.port, bridge.token, "page.readAX", { tabId })) as unknown as {
    ok: boolean;
    result?: { source: string; nodes: Array<{ role: string }> };
  };
  expect(reply.ok).toBe(true);
  expect(reply.result?.source).toBe("scripting");
  expect(reply.result?.nodes.length).toBeGreaterThan(0);

  await page.evaluate((id) => chrome.debugger.detach({ tabId: id }), tabId);

  // With the other debugger gone, the next read attaches and reports itself.
  const recovered = (await bridgeCall(bridge.port, bridge.token, "page.readAX", { tabId })) as unknown as {
    result?: { source: string };
  };
  expect(recovered.result?.source).toBe("debugger");
});

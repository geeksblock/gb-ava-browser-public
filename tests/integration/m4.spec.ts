import { copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { BridgeClient } from "../../adapter/src/client.js";
import {
  NeedsHumanError,
  browser_click,
  browser_download,
  browser_evaluate,
  browser_navigate,
  browser_read_page,
  browser_screenshot,
  browser_session_end,
  browser_session_start,
  browser_tabs,
  browser_type,
  browser_upload,
  browser_wait,
} from "../../adapter/src/tools.js";
import {
  bridgeCall,
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
 * M4: the Cua-shaped adapter driving the real extension through the real bridge.
 * This is the end-to-end path an agent takes — adapter → bridge → extension →
 * Chrome — with the tab never activated.
 */

let bridge: BridgeHandle;

/** Copy a fixture into the bridge's upload folder and return its path there. */
function stageUpload(source: string): string {
  const target = join(bridge.uploadDir, basename(source));
  copyFileSync(source, target);
  return target;
}
let extension: ExtensionHandle;
let site: FixtureSite;
let client: BridgeClient;

test.beforeEach(async () => {
  bridge = await startBridge();
  site = await startFixtureSite();
  extension = await launchExtension();
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);
  await waitForConnected(bridge.port);
  client = new BridgeClient({ port: bridge.port, token: bridge.token });
});

test.afterEach(async () => {
  await extension?.close();
  await bridge?.stop();
  await site?.close();
});

const context = () => ({ client });

async function backgroundTab(path: string): Promise<number> {
  const page = await extension.context.newPage();
  await page.goto(site.url(path));
  const front = await extension.context.newPage();
  await front.goto("about:blank");
  await front.bringToFront();
  const listed = (await bridgeCall(bridge.port, bridge.token, "tabs.list", {})) as unknown as {
    result?: { tabs: Array<{ tabId: number; url: string | null; active: boolean }> };
  };
  const target = listed.result?.tabs.find((tab) => tab.url === site.url(path));
  expect(target).toBeTruthy();
  expect(target!.active).toBe(false);
  return target!.tabId;
}

test("M4: the adapter signs in on a background tab end to end", async () => {
  const tabId = await backgroundTab("/signin");

  const session = (await browser_session_start(context(), { tabIds: [tabId] })) as {
    marker: { group: { color: string; title: string } | null };
  };
  expect(session.marker.group?.color).toBe("red");
  expect(session.marker.group?.title).toBe("Ava");

  const page = (await browser_read_page(context(), { tabId })) as { text: string; tree: { nodes: unknown[] } };
  expect(page.text).toContain("Sign in");
  expect(page.tree.nodes.length).toBeGreaterThan(0);

  await browser_type(context(), { tabId, selector: "#email", text: "ava@example.com", pressEnter: true });
  await browser_wait(context(), { tabId, selector: "#code", timeoutMs: 8_000 });
  await browser_type(context(), { tabId, selector: "#code", text: "123456789", pressEnter: true });
  const done = (await browser_wait(context(), { tabId, urlIncludes: "/done", timeoutMs: 8_000 })) as { url: string };
  expect(done.url).toBe(site.url("/done"));

  const shot = (await browser_screenshot(context(), { tabId })) as { png: string; width: number };
  expect(shot.png.startsWith("iVBORw0KGgo")).toBe(true);
  expect(shot.width).toBeGreaterThan(0);

  await browser_session_end(context());
  const ended = (await browser_tabs(context(), {})) as { tabs: Array<{ tabId: number; groupId: number; active: boolean }> };
  expect(ended.tabs.find((tab) => tab.tabId === tabId)?.groupId).toBe(-1);
  expect(ended.tabs.find((tab) => tab.tabId === tabId)?.active).toBe(false);
});

test("M4: the adapter reports a JavaScript dialog as NeedsHuman and never dismisses it", async () => {
  const tabId = await backgroundTab("/form");
  const page = extension.context.pages().find((candidate) => candidate.url() === site.url("/form"));
  const held: { dialog?: unknown } = {};
  const opened = new Promise<void>((resolve) => {
    page!.once("dialog", (dialog) => {
      held.dialog = dialog;
      resolve();
    });
  });

  // The click lands and a dialog is up: the adapter raises the typed error rather
  // than returning a success a Cua caller would walk past.
  const failure = await browser_click(context(), { tabId, selector: "#alertButton" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(NeedsHumanError);
  expect((failure as NeedsHumanError).reason).toBe("javascript_dialog");
  await opened;

  // The adapter surfaces the next command's refusal as the typed error, with the
  // reason intact — an agent can branch on this without parsing prose.
  await expect(browser_click(context(), { tabId, selector: "#save" })).rejects.toBeInstanceOf(NeedsHumanError);

  await (held.dialog as { dismiss(): Promise<void> }).dismiss();
  await waitForNoDialog(bridge.port, bridge.token, tabId);
  const after = (await browser_click(context(), { tabId, selector: "#save" })) as { clicked: { x: number } };
  expect(after.clicked.x).toBeGreaterThan(0);
});

test("M4: the adapter reports an intercepted file chooser and resolves it with an upload", async () => {
  const tabId = await backgroundTab("/form");

  // Clicking the input opens Chrome's file chooser; the extension intercepts it, so
  // no modal picker appears and the click says a human (or an upload) is expected.
  const failure = await browser_click(context(), { tabId, selector: "#file" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(NeedsHumanError);
  expect((failure as NeedsHumanError).reason).toBe("file_picker");

  const health = (await bridgeCall(bridge.port, bridge.token, "health", {})) as unknown as {
    result: { dialogs: { fileChooser: Array<{ tabId: number; backendNodeId: number }> } };
  };
  // The pending chooser is visible in health, so an operator can see why a page is
  // waiting without reading logs.
  const pending = health.result.dialogs.fileChooser.find((entry) => entry.tabId === tabId);
  expect(pending?.backendNodeId).toBeGreaterThan(0);

  // Answering the chooser that is open: the upload targets the same input, so the
  // pending record settles.
  const uploaded = (await browser_upload(context(), {
    tabId,
    selector: "#file",
    // page.upload attaches only from the bridge's upload folder (ADR 0005).
    files: [stageUpload(new URL("../fixtures/note.txt", import.meta.url).pathname)],
  })) as { count: number };
  expect(uploaded.count).toBe(1);

  // The page really received the file (the count above is only an echo).
  await enableEvaluate(await extension.optionsPage(), bridge.port, bridge.token);
  const received = (await browser_evaluate(context(), {
    tabId,
    expression: "document.querySelector('#file').files[0]?.name ?? null",
  })) as { value: string | null };
  expect(received.value).toBe("note.txt");

  const settled = (await bridgeCall(bridge.port, bridge.token, "health", {})) as unknown as {
    result: { dialogs: { fileChooser: Array<{ tabId: number }> } };
  };
  expect(settled.result.dialogs.fileChooser.find((entry) => entry.tabId === tabId)).toBeUndefined();
});

test("M4: the adapter downloads and reports what Chrome saved", async () => {
  const tabId = await backgroundTab("/form");
  const reply = (await browser_download(context(), { tabId, selector: "#dlink", timeoutMs: 8_000 })) as {
    download: { finalUrl: string; state: string };
  };
  expect(reply.download.finalUrl).toContain("/download.txt");
  expect(["in_progress", "complete"]).toContain(reply.download.state);
});

test("M5: the audit trail records commands without page content or typed text", async () => {
  const tabId = await backgroundTab("/signin");
  await browser_type(context(), { tabId, selector: "#email", text: "secret-password-value", clear: true });

  const health = (await bridgeCall(bridge.port, bridge.token, "health", {})) as unknown as {
    result: {
      audit: { capacity: number; size: number; recent: Array<{ method: string; args: string; outcome: string }> };
    };
  };
  const audit = health.result.audit;
  expect(audit.capacity).toBe(500);
  expect(audit.size).toBeGreaterThan(0);
  expect(audit.recent.some((entry) => entry.method === "page.type")).toBe(true);

  // Nothing in the ring carries page text or the typed value.
  const serialised = JSON.stringify(audit);
  expect(serialised).not.toContain("secret-password-value");
  expect(serialised).not.toContain("Sign in");
  const typed = audit.recent.find((entry) => entry.method === "page.type");
  expect(typed?.args).toMatch(/text:\d+ch/);
  expect(typed?.args).toContain("selector:#email");

  // A command refused before it ran is still recorded, with its code: an agent that
  // keeps sending a bad parameter is visible in the trail.
  await client.call("page.readAX", { tabId, limit: 0 }).catch(() => undefined);
  const afterRefusal = (await bridgeCall(bridge.port, bridge.token, "health", {})) as unknown as {
    result: { audit: { recent: Array<{ method: string; outcome: string; code: string | null }> } };
  };
  const refused = afterRefusal.result.audit.recent.find((entry) => entry.method === "page.readAX");
  expect(refused?.outcome).toBe("error");
  expect(refused?.code).toBe("invalid_request");
});

test("M4: the adapter's navigation and read stay off the foreground", async () => {
  const tabId = await backgroundTab("/alpha");
  const navigated = (await browser_navigate(context(), { tabId, url: site.url("/done") })) as { url: string };
  expect(navigated.url).toBe(site.url("/done"));

  const page = (await browser_read_page(context(), { tabId })) as { text: string };
  expect(page.text).toContain("signed in");

  const tabs = (await browser_tabs(context(), {})) as { tabs: Array<{ tabId: number; active: boolean }> };
  expect(tabs.tabs.find((tab) => tab.tabId === tabId)?.active).toBe(false);
});

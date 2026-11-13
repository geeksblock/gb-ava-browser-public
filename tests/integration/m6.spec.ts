import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  configureViaOptionsPage,
  launchExtension,
  repoRoot,
  startBridge,
  startFixtureSite,
  waitForConnected,
  type BridgeHandle,
  type ExtensionHandle,
  type FixtureSite,
} from "./helpers.js";

/**
 * M6: the MCP server, speaking real JSON-RPC over stdio to a real bridge and a
 * real extension. This is the path an agent host takes, so it is tested as a
 * process, not as a function.
 */

let bridge: BridgeHandle;
let extension: ExtensionHandle;
let site: FixtureSite;
let mcp: ChildProcess;

test.beforeEach(async () => {
  bridge = await startBridge();
  site = await startFixtureSite();
  extension = await launchExtension();
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);
  await waitForConnected(bridge.port);

  mcp = spawn(process.execPath, [join(repoRoot, "mcp", "dist", "index.js")], {
    env: {
      ...process.env,
      AVA_BRIDGE_PORT: String(bridge.port),
      AVA_BRIDGE_CONFIG_DIR: bridge.configDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
});

test.afterEach(async () => {
  mcp?.kill("SIGTERM");
  await extension?.close();
  await bridge?.stop();
  await site?.close();
});

let nextId = 1;

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  const request = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${method} within 30 s`)), 30_000);
    const onData = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message["id"] !== id) continue;
        clearTimeout(timer);
        mcp.stdout?.off("data", onData);
        resolve(message);
        return;
      }
    };
    mcp.stdout?.on("data", onData);
    mcp.stdin?.write(request);
  });
}

test("M6: the MCP server handshakes, lists tools and drives the real extension", async () => {
  const init = (await call("initialize")).result as { protocolVersion: string; capabilities: { tools: unknown } };
  expect(init.protocolVersion).toBeTruthy();
  expect(init.capabilities.tools).toBeDefined();

  const listed = (await call("tools/list")).result as { tools: Array<{ name: string }> };
  const names = listed.tools.map((tool) => tool.name);
  expect(names).toContain("browser_tabs");
  expect(names).toContain("browser_read_page");

  const tabs = (await call("tools/call", { name: "browser_tabs", arguments: {} })) as {
    result: { content: Array<{ text: string }>; isError: boolean };
  };
  expect(tabs.result.isError).toBe(false);
  const parsed = JSON.parse(tabs.result.content[0]!.text) as { tabs: unknown[] };
  expect(Array.isArray(parsed.tabs)).toBe(true);
});

test("M6: a needs-human answer reaches the model as an actionable error", async () => {
  const tab = await extension.context.newPage();
  await tab.goto(site.url("/form"));
  const front = await extension.context.newPage();
  await front.goto("about:blank");
  await front.bringToFront();

  const listed = (await call("tools/call", { name: "browser_tabs", arguments: {} })) as {
    result: { content: Array<{ text: string }> };
  };
  const tabs = JSON.parse(listed.result.content[0]!.text) as { tabs: Array<{ tabId: number; url: string | null }> };
  const target = tabs.tabs.find((entry) => entry.url === site.url("/form"));
  expect(target).toBeTruthy();

  const held: { dialog?: unknown } = {};
  const opened = new Promise<void>((resolve) => {
    tab.once("dialog", (dialog) => {
      held.dialog = dialog;
      resolve();
    });
  });

  const clicked = (await call("tools/call", {
    name: "browser_click",
    arguments: { tabId: target!.tabId, selector: "#alertButton" },
  })) as { result: { isError: boolean; content: Array<{ text: string }> } };
  expect(clicked.result.isError).toBe(true);
  const body = JSON.parse(clicked.result.content[0]!.text) as { needs_human: boolean; reason: string; next: string };
  expect(body.needs_human).toBe(true);
  expect(body.reason).toBe("javascript_dialog");
  expect(body.next).toContain("Ask the owner");

  await opened;
  await (held.dialog as { dismiss(): Promise<void> }).dismiss();
});

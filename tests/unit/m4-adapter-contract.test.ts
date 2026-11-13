/**
 * The adapter ↔ protocol contract, checked as a whole.
 *
 * #26 shipped because `browser_find_tab` sent `urlIncludes` where `tabs.query` takes
 * `urlPattern`. The parser was correct and the adapter was wrong, and nothing compared
 * the two. This file does that comparison for **every** adapter tool: it drives each
 * `browser_*` function through a recording client and runs the parameters the adapter
 * actually put on the wire through the real protocol parser.
 *
 * A future adapter that renames, drops, or invents a parameter fails here rather than
 * in a live bridge.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as protocol from "../../shared/src/protocol.js";
import * as adapter from "../../adapter/src/tools.js";
import type { ToolContext } from "../../adapter/src/tools.js";

type Parser = (params: unknown) => { ok: boolean; error?: { message: string } };

/** A real file on disk, because upload now validates the path before the bridge. */
const UPLOAD_FIXTURE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "gb-ava-upload-"));
  const file = join(dir, "a.txt");
  writeFileSync(file, "attach me\n");
  return file;
})();

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** An adapter function plus the parser its wire method must satisfy. */
interface Case {
  tool: string;
  invoke: (context: ToolContext) => Promise<unknown>;
  parser: string;
}

/** Look a parser up by name, failing loudly rather than asserting the type away. */
function parserNamed(name: string): Parser {
  const found = (protocol as unknown as Record<string, Parser | undefined>)[name];
  if (typeof found !== "function") throw new Error(`no such parser: ${name}`);
  return found;
}

function recordingContext(reply: (method: string) => unknown = () => ({ ok: true })): {
  context: ToolContext;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      return reply(method);
    },
  };
  return { context: { client } as unknown as ToolContext, calls };
}

const CASES: Case[] = [
  { tool: "browser_tabs", invoke: (c) => adapter.browser_tabs(c, { limit: 10 }), parser: "parseListParams" },
  {
    tool: "browser_find_tab",
    invoke: (c) => adapter.browser_find_tab(c, { urlIncludes: "example.com", titleContains: "Ex" }),
    parser: "parseQueryParams",
  },
  {
    tool: "browser_navigate",
    invoke: (c) => adapter.browser_navigate(c, { tabId: 1, url: "https://example.com/" }),
    parser: "parseNavigateParams",
  },
  { tool: "browser_close_tab", invoke: (c) => adapter.browser_close_tab(c, { tabId: 1 }), parser: "parseCloseParams" },
  {
    tool: "browser_activate_tab",
    invoke: (c) => adapter.browser_activate_tab(c, { tabId: 1, focusWindow: false }),
    parser: "parseActivateParams",
  },
  {
    tool: "browser_session_start",
    invoke: (c) => adapter.browser_session_start(c, { tabIds: [1] }),
    parser: "parseSessionStartParams",
  },
  { tool: "browser_session_status", invoke: (c) => adapter.browser_session_status(c), parser: "parseSessionStatusParams" },
  { tool: "browser_session_end", invoke: (c) => adapter.browser_session_end(c), parser: "parseSessionEndParams" },
  {
    tool: "browser_read_page",
    invoke: (c) => adapter.browser_read_page(c, { tabId: 1, limit: 10 }),
    // Two reads: the text parser and the AX parser. Covered below explicitly.
    parser: "parseReadAxParams",
  },
  {
    tool: "browser_screenshot",
    invoke: (c) => adapter.browser_screenshot(c, { tabId: 1 }),
    parser: "parseScreenshotParams",
  },
  {
    tool: "browser_click",
    invoke: (c) => adapter.browser_click(c, { tabId: 1, nodeId: 5 }),
    parser: "parseClickParams",
  },
  {
    tool: "browser_type",
    invoke: (c) => adapter.browser_type(c, { tabId: 1, nodeId: 5, text: "hi" }),
    parser: "parseTypeParams",
  },
  { tool: "browser_key", invoke: (c) => adapter.browser_key(c, { tabId: 1, key: "Enter" }), parser: "parseKeyParams" },
  {
    tool: "browser_scroll",
    invoke: (c) => adapter.browser_scroll(c, { tabId: 1, deltaY: -100 }),
    parser: "parseScrollParams",
  },
  {
    tool: "browser_select",
    invoke: (c) => adapter.browser_select(c, { tabId: 1, nodeId: 5, value: "blue" }),
    parser: "parseSelectParams",
  },
  {
    tool: "browser_upload",
    // A REAL file: browser_upload now stats the path in Node before calling the
    // bridge (#33 item 7), so a fictional path is refused before reaching the wire.
    invoke: (c) => adapter.browser_upload(c, { tabId: 1, nodeId: 5, files: [UPLOAD_FIXTURE] }),
    parser: "parseUploadParams",
  },
  {
    tool: "browser_download",
    invoke: (c) => adapter.browser_download(c, { tabId: 1, nodeId: 5 }),
    parser: "parseDownloadParams",
  },
  {
    tool: "browser_wait",
    invoke: (c) => adapter.browser_wait(c, { tabId: 1, selector: "#done", timeoutMs: 1000 }),
    parser: "parseWaitForParams",
  },
  {
    tool: "browser_evaluate",
    invoke: (c) => adapter.browser_evaluate(c, { tabId: 1, expression: "1" }),
    parser: "parseEvaluateParams",
  },
];

/** Wire method per parser name, so a case can assert the method too. */
const METHOD_FOR_PARSER: Record<string, string> = {
  parseListParams: "tabs.list",
  parseQueryParams: "tabs.query",
  parseNavigateParams: "tabs.navigate",
  parseGroupParams: "tabs.group",
  parseUngroupParams: "tabs.ungroup",
  parseCloseParams: "tabs.close",
  parseActivateParams: "tabs.activate",
  parseSessionStartParams: "session.start",
  parseSessionStatusParams: "session.status",
  parseSessionEndParams: "session.end",
  parseReadAxParams: "page.readAX",
  parseGetTextParams: "page.getText",
  parseScreenshotParams: "page.screenshot",
  parseClickParams: "page.click",
  parseTypeParams: "page.type",
  parseKeyParams: "page.key",
  parseScrollParams: "page.scroll",
  parseSelectParams: "page.select",
  parseUploadParams: "page.upload",
  parseDownloadParams: "page.download",
  parseWaitForParams: "page.waitFor",
  parseEvaluateParams: "page.evaluate",
};

describe("every adapter tool puts parser-valid parameters on the wire", () => {
  it.each(CASES.map((c) => [c.tool, c] as const))("%s", async (_name, testCase) => {
    const { context, calls } = recordingContext();
    await testCase.invoke(context).catch(() => undefined);

    const parser = parserNamed(testCase.parser);
    const method = METHOD_FOR_PARSER[testCase.parser];
    const matching = calls.filter((call) => call.method === method);
    expect(matching.length, `${testCase.tool} never called ${method}`).toBeGreaterThan(0);

    for (const call of matching) {
      const result = parser(call.params);
      expect(result.ok, `${testCase.tool} sent ${method} ${JSON.stringify(call.params)}: ${result.error?.message}`).toBe(
        true,
      );
    }
  });
});

describe("browser_read_page's two reads are both valid", () => {
  it("sends page.getText and page.readAX parameters the parsers accept", async () => {
    const { context, calls } = recordingContext((method) =>
      method === "page.getText"
        ? { tabId: 1, text: "hi", length: 2, truncated: false, documentEpoch: 1 }
        : { tabId: 1, nodes: [], totalNodes: 0, truncated: false, documentEpoch: 1 },
    );
    await adapter.browser_read_page(context, { tabId: 1, limit: 10 });

    const getText = calls.find((call) => call.method === "page.getText");
    const readAX = calls.find((call) => call.method === "page.readAX");
    expect(getText).toBeDefined();
    expect(readAX).toBeDefined();

    expect(parserNamed("parseGetTextParams")(getText!.params).ok).toBe(true);
    expect(parserNamed("parseReadAxParams")(readAX!.params).ok).toBe(true);
  });
});

describe("the adapter never sends a key the protocol does not define", () => {
  it.each(CASES.map((c) => [c.tool, c] as const))("%s sends only allowlisted keys", async (_name, testCase) => {
    const { context, calls } = recordingContext();
    await testCase.invoke(context).catch(() => undefined);
    const method = METHOD_FOR_PARSER[testCase.parser];
    for (const call of calls.filter((entry) => entry.method === method)) {
      // The parser refuses unknown keys, so a pass here proves the allowlist held.
      const result = parserNamed(testCase.parser)(call.params);
      expect(result.ok, JSON.stringify(call.params)).toBe(true);
    }
  });
});

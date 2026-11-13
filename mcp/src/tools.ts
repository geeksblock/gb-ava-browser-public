/**
 * The MCP tool table: the adapter's Cua-shaped tools, described for a model.
 *
 * Each entry is one tool definition plus a handler that calls the adapter. The
 * descriptions are written for an agent that has to choose between them, and the
 * schemas are the same fail-closed shapes the protocol validates — an agent that
 * sends the wrong thing gets a protocol error naming the field.
 */

import {
  BridgeError,
  NeedsHumanError,
  browser_click,
  browser_close_tab,
  browser_download,
  browser_evaluate,
  browser_find_tab,
  browser_key,
  browser_navigate,
  browser_read_page,
  browser_screenshot,
  browser_scroll,
  browser_select,
  browser_activate_tab,
  browser_create_tab,
  browser_session_end,
  browser_session_start,
  browser_session_status,
  browser_tabs,
  browser_type,
  browser_upload,
  browser_wait,
  type ToolContext,
} from "../../adapter/src/index.js";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (context: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

const tabId = { type: "integer", minimum: 0, description: "Tab id from browser_tabs or browser_find_tab." };
const target = {
  nodeId: { type: "integer", minimum: 0, description: "AX node id from browser_read_page (preferred). Null for a node read from an iframe — use its selector instead." },
  selector: { type: "string", description: "CSS selector in the page's light DOM (not inside shadow roots). Resolved inside child frames too." },
  x: { type: "integer", minimum: 0, description: "Viewport x, used with y." },
  y: { type: "integer", minimum: 0, description: "Viewport y, used with x." },
};

function required(properties: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return { type: "object", properties, required: keys, additionalProperties: false };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "browser_tabs",
    description: "List open tabs with ids, urls, titles and group ids. Start here: every other tool needs a tabId.",
    inputSchema: required({ limit: { type: "integer", minimum: 1, maximum: 200 } }, []),
    handler: (context, args) => browser_tabs(context, { limit: args["limit"] as number | undefined }),
  },
  {
    name: "browser_find_tab",
    description: "Find tabs by a url or title substring. Returns matches; use a tabId from the result.",
    inputSchema: required(
      { urlIncludes: { type: "string" }, titleContains: { type: "string" } },
      [],
    ),
    handler: (context, args) =>
      browser_find_tab(context, {
        ...(args["urlIncludes"] === undefined ? {} : { urlIncludes: String(args["urlIncludes"]) }),
        ...(args["titleContains"] === undefined ? {} : { titleContains: String(args["titleContains"]) }),
      }),
  },
  {
    name: "browser_session_start",
    description:
      "First step before touching a tab: groups it red and titled 'Ava'. The chip in the tab strip is Chrome's group label and exists only while a tab is in the group, so without this the owner sees nothing. Pass the tab ids to mark. Calling with no tabIds keeps whatever tabs the session already has — it does not clear them — so omit it on a retry rather than passing an empty array.",
    inputSchema: required({ tabIds: { type: "array", items: { type: "integer" }, maxItems: 100 } }, []),
    handler: (context, args) => browser_session_start(context, args["tabIds"] === undefined ? {} : { tabIds: args["tabIds"] as number[] }),
  },
  {
    name: "browser_activate_tab",
    description:
      "Select a tab in its window (chrome.tabs.update active:true). It does NOT raise the window, so the owner's attention is untouched — `focusWindow: true` is the explicit opt-in. Use it when a site only renders or only responds on the active tab, or when another tool that can only see the active tab (cua-driver) needs this one in front. The reply says whether the window came forward.",
    inputSchema: required({ tabId, focusWindow: { type: "boolean" } }, ["tabId"]),
    handler: (context, args) =>
      browser_activate_tab(context, {
        tabId: Number(args["tabId"]),
        ...(args["focusWindow"] === undefined ? {} : { focusWindow: args["focusWindow"] === true }),
      }),
  },
  {
    name: "browser_create_tab",
    description:
      "Open a new tab on a URL. It opens in the BACKGROUND by default (active:false), so Chrome is not raised and the owner's attention is untouched — this is the way to reach a page the user has not already opened without stealing focus. Answers once the page has finished loading, with the same tab descriptor as browser_tabs. Pass `background: false` only when the caller actually wants the tab focused.",
    inputSchema: required(
      {
        url: { type: "string", description: "Absolute http:, https:, file: or about: URL." },
        windowId: { type: "integer", description: "Window to open the tab in. Defaults to the window Chrome chooses." },
        background: { type: "boolean", description: "Default true: open without focusing. false focuses the tab." },
        pinned: { type: "boolean", description: "Open the tab pinned." },
      },
      ["url"],
    ),
    handler: (context, args) =>
      browser_create_tab(context, {
        url: String(args["url"]),
        ...(args["windowId"] === undefined ? {} : { windowId: Number(args["windowId"]) }),
        ...(args["background"] === undefined ? {} : { background: args["background"] === true }),
        ...(args["pinned"] === undefined ? {} : { pinned: args["pinned"] === true }),
      }),
  },
  {
    name: "browser_session_status",
    description:
      "What the session holds right now: the driven tab ids, which of them still exist, which have vanished, and whether the Ava group is painted. Use it mid-task to notice that the owner closed the tab you were driving, instead of discovering it as not_found on the next call.",
    inputSchema: required({}, []),
    handler: (context) => browser_session_status(context),
  },
  {
    name: "browser_session_end",
    description: "End the marked session and ungroup every tab it held.",
    inputSchema: required({}, []),
    handler: (context) => browser_session_end(context),
  },
  {
    name: "browser_navigate",
    description:
      "Navigate a tab to a URL without bringing it to the front, and wait for the load. Http(s), file and about:blank only.",
    inputSchema: required({ tabId, url: { type: "string" } }, ["tabId", "url"]),
    handler: (context, args) => browser_navigate(context, { tabId: Number(args["tabId"]), url: String(args["url"]) }),
  },
  {
    name: "browser_close_tab",
    description: "Close one explicit tab.",
    inputSchema: required({ tabId }, ["tabId"]),
    handler: (context, args) => browser_close_tab(context, { tabId: Number(args["tabId"]) }),
  },
  {
    name: "browser_read_page",
    description:
      "Read a tab that is not in front: rendered text plus the accessibility tree with node ids. This is the normal way to see a page. Use the node ids for browser_click and browser_type. Content inside iframes is included: a node from a frame has nodeId null and a selector — click it by that selector. `frames` and `framesNotRead` say which frames were read, so a short read is never mistaken for an empty page. Checkboxes, radios and switches carry `checked` (true/false), so a tick can be verified from the tree without page.evaluate; other roles report it as null. Two separate caps: `limit` counts AX nodes (default 50), `textLimit` counts rendered characters (default 20000, max 200000) — raise textLimit when a long page comes back truncated.",
    inputSchema: required(
      {
        tabId,
        limit: { type: "integer", minimum: 1, maximum: 4000, description: "Maximum AX nodes (1-4000)." },
        textLimit: {
          type: "integer",
          minimum: 1,
          maximum: 200_000,
          description: "Maximum characters of rendered text (1-200000, default 20000).",
        },
      },
      ["tabId"],
    ),
    handler: (context, args) =>
      browser_read_page(context, {
        tabId: Number(args["tabId"]),
        ...(args["limit"] === undefined ? {} : { limit: Number(args["limit"]) }),
        ...(args["textLimit"] === undefined ? {} : { textLimit: Number(args["textLimit"]) }),
      }),
  },
  {
    name: "browser_screenshot",
    description:
      "PNG of one tab (not the window), base64. Works on a background tab; `possiblyStale` says the bytes match the previous capture, so prefer browser_read_page when structure must be current.",
    inputSchema: required({ tabId, detectStale: { type: "boolean" } }, ["tabId"]),
    handler: (context, args) =>
      browser_screenshot(context, {
        tabId: Number(args["tabId"]),
        ...(args["detectStale"] === undefined ? {} : { detectStale: args["detectStale"] === true }),
      }),
  },
  {
    name: "browser_click",
    description:
      "Click a target in a tab: an AX node id (preferred), a CSS selector, or viewport coordinates — exactly one kind. Works on a background tab: pointer input is dispatched inside the page when the tab is hidden, because Chrome does not apply CDP mouse events to a renderer it is not compositing. The reply's `input.route` says which route ran. A click that opens a dialog or file chooser raises a needs-human error.",
    inputSchema: required(
      {
        tabId,
        ...target,
        button: { type: "string", enum: ["left", "right", "middle"] },
        inputRoute: { type: "string", enum: ["auto", "cdp", "scripted"] },
      },
      ["tabId"],
    ),
    handler: (context, args) =>
      browser_click(context, {
        tabId: Number(args["tabId"]),
        ...(args["nodeId"] === undefined ? {} : { nodeId: Number(args["nodeId"]) }),
        ...(args["selector"] === undefined ? {} : { selector: String(args["selector"]) }),
        ...(args["x"] === undefined ? {} : { x: Number(args["x"]) }),
        ...(args["y"] === undefined ? {} : { y: Number(args["y"]) }),
        ...(args["button"] === undefined ? {} : { button: args["button"] as "left" | "right" | "middle" }),
        ...(args["inputRoute"] === undefined ? {} : { inputRoute: args["inputRoute"] as "auto" | "cdp" | "scripted" }),
      }),
  },
  {
    name: "browser_type",
    description:
      "Type into a field in a tab. `clear` replaces the existing value; `pressEnter` submits. Never retried: a timeout means the outcome is unknown.",
    inputSchema: required(
      {
        tabId,
        ...target,
        text: { type: "string" },
        clear: { type: "boolean" },
        pressEnter: { type: "boolean" },
        inputRoute: { type: "string", enum: ["auto", "cdp", "scripted"] },
      },
      ["tabId", "text"],
    ),
    handler: (context, args) =>
      browser_type(context, {
        tabId: Number(args["tabId"]),
        text: String(args["text"]),
        ...(args["nodeId"] === undefined ? {} : { nodeId: Number(args["nodeId"]) }),
        ...(args["selector"] === undefined ? {} : { selector: String(args["selector"]) }),
        ...(args["x"] === undefined ? {} : { x: Number(args["x"]) }),
        ...(args["y"] === undefined ? {} : { y: Number(args["y"]) }),
        ...(args["clear"] === undefined ? {} : { clear: args["clear"] === true }),
        ...(args["pressEnter"] === undefined ? {} : { pressEnter: args["pressEnter"] === true }),
        ...(args["inputRoute"] === undefined ? {} : { inputRoute: args["inputRoute"] as "auto" | "cdp" | "scripted" }),
      }),
  },
  {
    name: "browser_key",
    description: "Press a named key (Enter, Tab, Escape, arrows, Home/End, PageUp/PageDown) with optional modifiers.",
    inputSchema: required(
      { tabId, key: { type: "string" }, modifiers: { type: "array", items: { type: "string", enum: ["alt", "ctrl", "meta", "shift"] } } },
      ["tabId", "key"],
    ),
    handler: (context, args) =>
      browser_key(context, {
        tabId: Number(args["tabId"]),
        key: String(args["key"]),
        ...(args["modifiers"] === undefined ? {} : { modifiers: args["modifiers"] as string[] }),
      }),
  },
  {
    name: "browser_scroll",
    description:
      "Scroll a tab by deltaY/deltaX pixels. No target is needed: without one the page's own scroller moves. With a nodeId it scrolls that element's nearest scrollable container (this is how content below the fold is reached), and with x/y the element under the point decides. Scrolling happens inside the page, so it works on a background tab.",
    inputSchema: required(
      { tabId, ...target, deltaY: { type: "integer" }, deltaX: { type: "integer" } },
      ["tabId"],
    ),
    handler: (context, args) =>
      browser_scroll(context, {
        tabId: Number(args["tabId"]),
        ...(args["deltaY"] === undefined ? {} : { deltaY: Number(args["deltaY"]) }),
        ...(args["deltaX"] === undefined ? {} : { deltaX: Number(args["deltaX"]) }),
        ...(args["nodeId"] === undefined ? {} : { nodeId: Number(args["nodeId"]) }),
        ...(args["selector"] === undefined ? {} : { selector: String(args["selector"]) }),
        ...(args["x"] === undefined ? {} : { x: Number(args["x"]) }),
        ...(args["y"] === undefined ? {} : { y: Number(args["y"]) }),
      }),
  },
  {
    name: "browser_select",
    description:
      "Choose an option in a <select>, firing the same events a user's choice does. An option the control marks disabled is refused. A selector matching more than one element is refused with detail.matchCount and detail.matches — make the selector specific (an id or a name) instead of retrying. The reply names the control it matched.",
    inputSchema: required({ tabId, ...target, value: { type: "string" } }, ["tabId", "value"]),
    handler: (context, args) =>
      browser_select(context, {
        tabId: Number(args["tabId"]),
        value: String(args["value"]),
        ...(args["nodeId"] === undefined ? {} : { nodeId: Number(args["nodeId"]) }),
        ...(args["selector"] === undefined ? {} : { selector: String(args["selector"]) }),
      }),
  },
  {
    name: "browser_upload",
    description: "Attach absolute file paths to a file input, including a hidden one. Satisfies a pending file-chooser request.",
    inputSchema: required({ tabId, ...target, files: { type: "array", items: { type: "string" }, minItems: 1 } }, [
      "tabId",
      "files",
    ]),
    handler: (context, args) =>
      browser_upload(context, {
        tabId: Number(args["tabId"]),
        files: args["files"] as string[],
        ...(args["nodeId"] === undefined ? {} : { nodeId: Number(args["nodeId"]) }),
        ...(args["selector"] === undefined ? {} : { selector: String(args["selector"]) }),
      }),
  },
  {
    name: "browser_download",
    description: "Click something that starts a download and report what Chrome saved.",
    inputSchema: required({ tabId, ...target, timeoutMs: { type: "integer", minimum: 100, maximum: 60000 } }, ["tabId"]),
    handler: (context, args) =>
      browser_download(context, {
        tabId: Number(args["tabId"]),
        ...(args["nodeId"] === undefined ? {} : { nodeId: Number(args["nodeId"]) }),
        ...(args["selector"] === undefined ? {} : { selector: String(args["selector"]) }),
        ...(args["timeoutMs"] === undefined ? {} : { timeoutMs: Number(args["timeoutMs"]) }),
      }),
  },
  {
    name: "browser_wait",
    description:
      "Wait until a selector exists, page text appears, or the URL contains a string. On timeout it reports which condition was last unmet.",
    inputSchema: required(
      {
        tabId,
        selector: { type: "string" },
        text: { type: "string" },
        urlIncludes: { type: "string" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
      },
      ["tabId"],
    ),
    handler: (context, args) =>
      browser_wait(context, {
        tabId: Number(args["tabId"]),
        ...(args["selector"] === undefined ? {} : { selector: String(args["selector"]) }),
        ...(args["text"] === undefined ? {} : { text: String(args["text"]) }),
        ...(args["urlIncludes"] === undefined ? {} : { urlIncludes: String(args["urlIncludes"]) }),
        ...(args["timeoutMs"] === undefined ? {} : { timeoutMs: Number(args["timeoutMs"]) }),
      }),
  },
  {
    name: "browser_evaluate",
    description:
      "Run JavaScript in a tab. Refused with 'evaluate_disabled' unless the owner has switched 'Allow page.evaluate' on in the extension options — do not work around it, ask the owner.",
    inputSchema: required(
      { tabId, expression: { type: "string" }, awaitPromise: { type: "boolean" } },
      ["tabId", "expression"],
    ),
    handler: (context, args) =>
      browser_evaluate(context, {
        tabId: Number(args["tabId"]),
        expression: String(args["expression"]),
        ...(args["awaitPromise"] === undefined ? {} : { awaitPromise: args["awaitPromise"] === true }),
      }),
  },
];

/** A tool error the model can act on: a human is needed, and why. */
export function describeError(error: unknown): { text: string; needsHuman: boolean } {
  if (error instanceof NeedsHumanError) {
    return {
      text: JSON.stringify({
        needs_human: true,
        reason: error.reason,
        tabId: error.tabId,
        message: error.message,
        detail: error.detail,
        next: "Ask the owner to attend to the browser; do not retry blindly.",
      }),
      needsHuman: true,
    };
  }
  if (error instanceof BridgeError) {
    return {
      text: JSON.stringify({ error: error.code, message: error.message, retryable: error.retryable, detail: error.detail }),
      needsHuman: false,
    };
  }
  return { text: JSON.stringify({ error: "internal", message: error instanceof Error ? error.message : String(error) }), needsHuman: false };
}

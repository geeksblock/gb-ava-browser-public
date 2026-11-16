/**
 * The Cua-shaped tools.
 *
 * One function per `browser_*` call Cua exposes. Each is a thin, documented
 * translation onto the protocol — no policy of its own beyond two rules: every
 * call names its tab, and a failure that needs a human becomes a
 * `NeedsHumanError` instead of a retry.
 *
 * What this layer adds on top of the protocol:
 *   - `browser_read_page` returns text and an accessibility summary in one answer,
 *     because that is one decision for a caller;
 *   - a stalled command is checked for a CAPTCHA before it is reported as a plain
 *     timeout: `classifyStall` only names a reason it can justify;
 *   - errors are typed (NeedsHumanError / BridgeError) so an agent can branch on
 *     "ask the owner" versus "try again".
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { BridgeClient } from "./client.js";
import { BridgeError, NeedsHumanError, classifyStall, toAdapterError } from "./errors.js";
import type { NeedsHumanReason } from "./errors.js";

export interface ToolContext {
  client: BridgeClient;
}

export interface TabTarget {
  tabId: number;
}

export interface ElementTarget extends TabTarget {
  /** Preferred: a node id from a previous read. */
  nodeId?: number;
  selector?: string;
  x?: number;
  y?: number;
}

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>;

async function callWith(context: ToolContext, method: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await context.client.call(method, params);
  } catch (error) {
    if (error instanceof BridgeError) {
      throw toAdapterError({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        detail: error.detail,
      });
    }
    throw error;
  }
}

/** A CAPTCHA marker, used only to explain a stall that already happened. */
const CAPTCHA_PROBE = `(() => {
  const markers = ["iframe[src*='recaptcha']", ".g-recaptcha", "[data-sitekey]", "iframe[src*='hcaptcha']", ".cf-turnstile"];
  return markers.some((selector) => document.querySelector(selector) !== null)
    || /verify you are human|i'm not a robot/i.test(document.body ? document.body.innerText : "");
})()`;

async function captchaPresent(context: ToolContext, tabId: number): Promise<boolean> {
  try {
    const probe = (await callWith(context, "page.evaluate", { tabId, expression: CAPTCHA_PROBE })) as { value?: unknown };
    return probe.value === true;
  } catch {
    // evaluate can be disabled; a stall without an explanation stays a timeout.
    return false;
  }
}

async function withStallClassification<T>(context: ToolContext, tabId: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "timeout") throw error;
    const reason = classifyStall({ captchaPresent: await captchaPresent(context, tabId) });
    if (reason === null) throw error;
    throw new NeedsHumanError(reason, `${error.message} (the page is showing a CAPTCHA)`, tabId, { ...error.detail });
  }
}

/* ------------------------------------------------------------------ */
/* Tabs                                                               */
/* ------------------------------------------------------------------ */

export async function browser_tabs(context: ToolContext, params: { limit?: number } = {}): Promise<unknown> {
  return callWith(context, "tabs.list", params.limit === undefined ? {} : { limit: params.limit });
}

/**
 * The tool's public parameter is `urlIncludes` — the same spelling `browser_wait` uses — but the
 * protocol's `tabs.query` takes `urlPattern`, and refuses any key it does not know. Rename at this
 * boundary; forwarding the params verbatim made every URL lookup an `invalid_request`.
 */
export async function browser_find_tab(
  context: ToolContext,
  params: { urlIncludes?: string; titleContains?: string },
): Promise<unknown> {
  const payload: Record<string, unknown> = {};
  if (params.urlIncludes !== undefined) payload.urlPattern = params.urlIncludes;
  if (params.titleContains !== undefined) payload.titleContains = params.titleContains;
  return callWith(context, "tabs.query", payload);
}

export async function browser_navigate(context: ToolContext, params: TabTarget & { url: string }): Promise<unknown> {
  return withStallClassification(context, params.tabId, () =>
    callWith(context, "tabs.navigate", { tabId: params.tabId, url: params.url }),
  );
}

export async function browser_close_tab(context: ToolContext, params: TabTarget): Promise<unknown> {
  return callWith(context, "tabs.close", { tabId: params.tabId });
}

export async function browser_session_start(context: ToolContext, params: { tabIds?: number[] } = {}): Promise<unknown> {
  return callWith(context, "session.start", params.tabIds === undefined ? {} : { tabIds: params.tabIds });
}

export async function browser_activate_tab(
  context: ToolContext,
  params: TabTarget & { focusWindow?: boolean },
): Promise<unknown> {
  return callWith(context, "tabs.activate", {
    tabId: params.tabId,
    ...(params.focusWindow === undefined ? {} : { focusWindow: params.focusWindow }),
  });
}

/**
 * Open a tab. `background` defaults to true so this never pulls Chrome in front of
 * the human; pass `background: false` only when the caller wants the tab
 * focused, which is the opposite of what the product promises by default.
 */
export async function browser_create_tab(
  context: ToolContext,
  params: { url: string; windowId?: number; background?: boolean; pinned?: boolean },
): Promise<unknown> {
  return callWith(context, "tabs.create", {
    url: params.url,
    ...(params.windowId === undefined ? {} : { windowId: params.windowId }),
    ...(params.background === undefined ? {} : { background: params.background }),
    ...(params.pinned === undefined ? {} : { pinned: params.pinned }),
  });
}

/** What the session holds, and which driven tabs no longer exist. */
export async function browser_session_status(context: ToolContext): Promise<unknown> {
  return callWith(context, "session.status", {});
}

export async function browser_session_end(context: ToolContext): Promise<unknown> {
  return callWith(context, "session.end", {});
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

/**
 * Read a page: text and accessibility tree in one answer.
 *
 * Two caps, because they count different things and conflating them silently capped
 * the text. `limit` is the number of AX **nodes** (1..4000); `textLimit` is
 * **characters** of rendered text (up to 200,000, default 20,000). Passing `limit`
 * alone used to widen the tree while the text stayed at the protocol default
 * — a caller asking for "a bigger read" got half of one.
 */
export async function browser_read_page(
  context: ToolContext,
  params: TabTarget & { limit?: number; textLimit?: number },
): Promise<unknown> {
  // Two reads, not one: the protocol has no combined read. If the page changes in
  // between, the epochs disagree and the caller is told, rather than getting text
  // from one document and a tree from another.
  const text = (await callWith(context, "page.getText", {
    tabId: params.tabId,
    ...(params.textLimit === undefined ? {} : { limit: params.textLimit }),
  })) as Record<string, unknown>;
  let tree: Record<string, unknown> | null = null;
  let treeError: string | null = null;
  try {
    tree = (await callWith(context, "page.readAX", {
      tabId: params.tabId,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    })) as Record<string, unknown>;
  } catch (error) {
    // The text is still true and useful; losing it because the tree failed would be
    // a worse answer than a partial one.
    treeError = error instanceof Error ? error.message : String(error);
  }
  const sameDocument = tree !== null && tree["documentEpoch"] === text["documentEpoch"];
  return {
    tabId: params.tabId,
    text: text["text"],
    truncated: text["truncated"],
    // What the text cap actually was, so "truncated" is actionable rather than a
    // dead end: a caller that needs more can raise `textLimit` to this number.
    textLimit: params.textLimit ?? null,
    documentEpoch: text["documentEpoch"],
    // A portal's content is in an iframe: saying which frames were read, and which
    // were not, is what stops a shell-only read from looking like an empty page.
    frames: text["frames"] ?? [],
    framesNotRead: text["framesNotRead"] ?? [],
    tree,
    treeError,
    documentChangedDuringRead: tree !== null && !sameDocument,
  };
}

export async function browser_screenshot(context: ToolContext, params: TabTarget & { detectStale?: boolean }): Promise<unknown> {
  return callWith(context, "page.screenshot", {
    tabId: params.tabId,
    ...(params.detectStale === undefined ? {} : { detectStale: params.detectStale }),
  });
}

/* ------------------------------------------------------------------ */
/* Acting                                                             */
/* ------------------------------------------------------------------ */

function target(params: ElementTarget): Record<string, unknown> {
  const out: Record<string, unknown> = { tabId: params.tabId };
  if (params.nodeId !== undefined) out["nodeId"] = params.nodeId;
  if (params.selector !== undefined) out["selector"] = params.selector;
  if (params.x !== undefined && params.y !== undefined) {
    out["x"] = params.x;
    out["y"] = params.y;
  }
  return out;
}

/**
 * A click that opens a dialog or a file chooser *did* land — the protocol reports
 * that in the result. A Cua caller branches on exceptions, so the adapter raises
 * the typed error anyway, carrying the result in `detail` so nothing is lost.
 */
function humanBlockedOr(result: unknown, tabId: number): unknown {
  const pending = (result as { needsHuman?: { reason?: string; message?: string } | null }).needsHuman;
  if (pending === undefined || pending === null) return result;
  const reason = typeof pending.reason === "string" ? pending.reason : "unknown";
  throw new NeedsHumanError(
    (reason as NeedsHumanReason) ?? "unknown",
    pending.message ?? `tab ${tabId} is waiting for a human (${reason})`,
    tabId,
    { result },
  );
}

export async function browser_click(
  context: ToolContext,
  params: ElementTarget & { button?: "left" | "right" | "middle"; inputRoute?: "auto" | "cdp" | "scripted" },
): Promise<unknown> {
  return withStallClassification(context, params.tabId, async () =>
    humanBlockedOr(
      await callWith(context, "page.click", {
        ...target(params),
        ...(params.button === undefined ? {} : { button: params.button }),
        ...(params.inputRoute === undefined ? {} : { inputRoute: params.inputRoute }),
      }),
      params.tabId,
    ),
  );
}

export async function browser_type(
  context: ToolContext,
  params: ElementTarget & {
    text: string;
    clear?: boolean;
    pressEnter?: boolean;
    inputRoute?: "auto" | "cdp" | "scripted";
  },
): Promise<unknown> {
  return withStallClassification(context, params.tabId, async () =>
    humanBlockedOr(
      await callWith(context, "page.type", {
        ...target(params),
        text: params.text,
        ...(params.clear === undefined ? {} : { clear: params.clear }),
        ...(params.pressEnter === undefined ? {} : { pressEnter: params.pressEnter }),
        ...(params.inputRoute === undefined ? {} : { inputRoute: params.inputRoute }),
      }),
      params.tabId,
    ),
  );
}

export async function browser_key(context: ToolContext, params: TabTarget & { key: string; modifiers?: string[] }): Promise<unknown> {
  return callWith(context, "page.key", {
    tabId: params.tabId,
    key: params.key,
    ...(params.modifiers === undefined ? {} : { modifiers: params.modifiers }),
  });
}

export async function browser_scroll(
  context: ToolContext,
  params: TabTarget & { deltaY?: number; deltaX?: number; nodeId?: number; selector?: string; x?: number; y?: number },
): Promise<unknown> {
  // No target is normal: the document (or the page's own scroller) moves.
  if ((params.deltaY ?? 0) === 0 && (params.deltaX ?? 0) === 0) {
    throw new BridgeError("invalid_request", "browser_scroll needs a non-zero deltaY or deltaX", false);
  }
  return callWith(context, "page.scroll", {
    ...target({ tabId: params.tabId, nodeId: params.nodeId, selector: params.selector, x: params.x, y: params.y }),
    ...(params.deltaY === undefined ? {} : { deltaY: params.deltaY }),
    ...(params.deltaX === undefined ? {} : { deltaX: params.deltaX }),
  });
}

export async function browser_select(context: ToolContext, params: ElementTarget & { value: string }): Promise<unknown> {
  return callWith(context, "page.select", { ...target(params), value: params.value });
}

/**
 * Attach files to a file input.
 *
 * The paths are checked here, before the bridge is asked, because this layer runs in
 * Node on the same machine as the files and the extension does not: Chrome answers
 * `ok` for a path that does not exist by manufacturing a zero-byte `File` named after
 * it. Refusing up front is the only place the real answer is available.
 *
 * Absolute is required by the protocol (a relative path would resolve against
 * Chrome's cwd, not the caller's intent), so a relative path is refused with that
 * reason rather than as "missing".
 */
export async function browser_upload(
  context: ToolContext,
  params: ElementTarget & { files: string[] },
): Promise<unknown> {
  const notAbsolute = params.files.filter((file) => !isAbsolute(file));
  if (notAbsolute.length > 0) {
    throw new BridgeError("invalid_request", `cannot attach files: not an absolute path: ${notAbsolute.join(", ")}`, false, {
      files: notAbsolute,
    });
  }
  const problems = params.files.map((file) => describeFileProblem(file)).filter((entry): entry is string => entry !== null);
  if (problems.length > 0) {
    throw new BridgeError("invalid_request", `cannot attach files: ${problems.join("; ")}`, false, {
      files: params.files,
    });
  }
  return callWith(context, "page.upload", { ...target(params), files: params.files });
}

/** Why a path cannot be attached, or null when it can. */
function describeFileProblem(file: string): string | null {
  try {
    const stat = statSync(file);
    if (stat.isDirectory()) return `${file} is a directory`;
    if (!stat.isFile()) return `${file} is not a regular file`;
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `${file} does not exist`;
    if (code === "EACCES") return `${file} is not readable`;
    return `${file} cannot be read (${code ?? "unknown error"})`;
  }
}

export async function browser_download(context: ToolContext, params: ElementTarget & { timeoutMs?: number }): Promise<unknown> {
  return callWith(context, "page.download", {
    ...target(params),
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  });
}

export async function browser_wait(
  context: ToolContext,
  params: TabTarget & { selector?: string; text?: string; urlIncludes?: string; timeoutMs?: number },
): Promise<unknown> {
  const payload: Record<string, unknown> = { tabId: params.tabId };
  for (const key of ["selector", "text", "urlIncludes", "timeoutMs"] as const) {
    if (params[key] !== undefined) payload[key] = params[key];
  }
  return callWith(context, "page.waitFor", payload);
}

export async function browser_evaluate(
  context: ToolContext,
  params: TabTarget & { expression: string; awaitPromise?: boolean },
): Promise<unknown> {
  return callWith(context, "page.evaluate", {
    tabId: params.tabId,
    expression: params.expression,
    ...(params.awaitPromise === undefined ? {} : { awaitPromise: params.awaitPromise }),
  });
}

/** The tool table an agent is given: name, description, handler. */
export const CUA_TOOLS = {
  browser_tabs,
  browser_find_tab,
  browser_navigate,
  browser_close_tab,
  browser_session_start,
  browser_session_status,
  browser_session_end,
  browser_activate_tab,
  browser_create_tab,
  browser_read_page,
  browser_screenshot,
  browser_click,
  browser_type,
  browser_key,
  browser_scroll,
  browser_select,
  browser_upload,
  browser_download,
  browser_wait,
  browser_evaluate,
} as const;

export type CuaToolName = keyof typeof CUA_TOOLS;

export { BridgeClient, BridgeError, NeedsHumanError };
export type { Call };

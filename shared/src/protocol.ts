/**
 * Wire protocol v1 — Geeksblock Ava Browser Extension ⇄ local bridge.
 *
 * This file is the single source of truth for the message shapes on the loopback
 * socket. The bridge and the extension both import it; nothing else may invent a
 * message shape. See docs/protocol.md for the prose description and
 * IMPLEMENTATION-PLAN.md §5 for the decision record.
 *
 * Rules enforced by this module (AGENTS.md "Fail closed"):
 *   - a malformed envelope is an error, never a defaulted field;
 *   - an unknown method is an error, never a silent no-op;
 *   - every response carries the request id it answers.
 */

/** v2: mutual token proof, the raw token never crosses the wire (ADR 0005). */
export const PROTOCOL_VERSION = 2;
export const PRODUCT_NAME = "Geeksblock Ava Browser Extension";
export const BRIDGE_PRODUCT_NAME = "gb-ava-bridge";
export const MANUFACTURER = "Geeksblock LLC";

/** Maximum accepted length of a request id, method name or error message we echo back. */
export const MAX_ID_LENGTH = 128;
export const MAX_METHOD_LENGTH = 64;
export const MAX_MESSAGE_LENGTH = 2000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface RequestEnvelope {
  id: string;
  method: string;
  params?: JsonObject;
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  detail?: JsonObject;
}

export interface SuccessResponse {
  id: string;
  ok: true;
  result: JsonValue;
}

export interface ErrorResponse {
  id: string;
  ok: false;
  error: ErrorPayload;
}

export type ResponseEnvelope = SuccessResponse | ErrorResponse;

/**
 * The full error taxonomy for v1. Adding a code is a protocol change: update
 * docs/protocol.md and IMPLEMENTATION-PLAN.md §5/§7 in the same commit.
 */
export const ERROR_CODES = [
  "invalid_request",
  "unknown_method",
  "not_implemented",
  "unauthorized",
  "protocol_mismatch",
  "not_found",
  "tab_changed",
  "tab_busy",
  "needs_human",
  "debugger_unavailable",
  "evaluate_disabled",
  "extension_disconnected",
  "timeout",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Whether a caller may safely retry without a human decision. Only errors whose
 * handler did nothing (or was purely a read) may be retryable; `page.click` and
 * `page.type` are never retried automatically once sent.
 */
export const RETRYABLE_BY_DEFAULT: Record<ErrorCode, boolean> = {
  invalid_request: false,
  unknown_method: false,
  not_implemented: false,
  unauthorized: false,
  protocol_mismatch: false,
  not_found: false,
  tab_changed: false,
  tab_busy: true,
  needs_human: false,
  debugger_unavailable: false,
  evaluate_disabled: false,
  extension_disconnected: false,
  timeout: false,
  internal: false,
};

/** Human-blocked reasons surfaced as `needs_human` (plan §5). Never auto-dismissed. */
export const NEEDS_HUMAN_REASONS = [
  "webauthn",
  "permission_prompt",
  "javascript_dialog",
  "file_picker",
  "captcha",
] as const;

export type NeedsHumanReason = (typeof NEEDS_HUMAN_REASONS)[number];

/**
 * The v1 surface reserved by IMPLEMENTATION-PLAN §5. A name here is the contract
 * the M4 Cua adapter codes against; it does not imply the extension implements it
 * yet — an unimplemented reserved method fails with `not_implemented`, never a
 * silent success.
 */
export const V1_METHODS = [
  "tabs.list",
  "tabs.query",
  "tabs.navigate",
  "tabs.group",
  "tabs.ungroup",
  "tabs.close",
  "tabs.activate",
  "tabs.create",
  "page.readAX",
  "page.getText",
  "page.screenshot",
  "page.evaluate",
  "page.click",
  "page.type",
  "page.key",
  "page.scroll",
  "page.select",
  "page.upload",
  "page.download",
  "page.waitFor",
  "session.start",
  "session.end",
  "session.status",
  "health",
  "settings.get",
] as const;

export type V1Method = (typeof V1_METHODS)[number];

const V1_METHOD_SET: ReadonlySet<string> = new Set(V1_METHODS);

export function isV1Method(method: string): method is V1Method {
  return V1_METHOD_SET.has(method);
}

/**
 * Methods the extension answers today. M2 (page reads) and M3 (actions) extend
 * this list. Anything in neither list is rejected with `unknown_method`;
 * anything reserved but not yet built is `not_implemented`. Both are errors,
 * never silent no-ops.
 */
export const EXTENSION_METHODS = [
  "health",
  "settings.get",
  "session.start",
  "session.end",
  "session.status",
  "tabs.list",
  "tabs.query",
  "tabs.navigate",
  "tabs.group",
  "tabs.ungroup",
  "tabs.close",
  "tabs.activate",
  "tabs.create",
  "page.readAX",
  "page.getText",
  "page.screenshot",
  "page.click",
  "page.type",
  "page.key",
  "page.scroll",
  "page.select",
  "page.upload",
  "page.download",
  "page.waitFor",
  "page.evaluate",
] as const;

export type ExtensionMethod = (typeof EXTENSION_METHODS)[number];

const EXTENSION_METHOD_SET: ReadonlySet<string> = new Set(EXTENSION_METHODS);

export function isKnownMethod(method: string): method is ExtensionMethod {
  return EXTENSION_METHOD_SET.has(method);
}

/* ------------------------------------------------------------------ */
/* M1 — tabs and the marker                                           */
/* ------------------------------------------------------------------ */

/**
 * The marker (plan §4): one group per browser, this colour and this title,
 * no icons, no other text. Nothing in the code may decide behaviour from group
 * membership — the group is a visible signal for the human, and the extension
 * tracks its own tab set independently.
 */
export const TAB_GROUP_COLOR = "red" as const;
export const TAB_GROUP_TITLE = "Ava" as const;

/** A tab as the agent sees it. No page content, no cookies, no history. */
export interface TabDescriptor {
  tabId: number;
  windowId: number;
  index: number;
  active: boolean;
  pinned: boolean;
  /** Null for a tab the extension may not read (chrome://, other extension pages). */
  url: string | null;
  title: string | null;
  status: string | null;
  /** -1 when the tab is in no group. */
  groupId: number;
}

/** Bound on any list result, so a 400-tab window cannot flood the model. */
export const TAB_LIMIT_DEFAULT = 50;
export const TAB_LIMIT_MAX = 200;
export const TAB_BATCH_MAX = 100;
export const MAX_URL_LENGTH = 2048;

export interface TabQuery {
  urlPattern?: string;
  titleContains?: string;
  groupId?: number;
  windowId?: number;
  active?: boolean;
  pinned?: boolean;
  limit: number;
}

export interface NavigateParams {
  tabId: number;
  url: string;
}

export interface CreateParams {
  url: string;
  windowId?: number;
  background?: boolean;
  pinned?: boolean;
}

export interface GroupParams {
  tabIds: number[];
  groupId?: number;
}

export interface ListParams {
  groupId?: number;
  windowId?: number;
  limit: number;
}

function rejectUnknownKeys(params: JsonObject, allowed: readonly string[], method: string): ValidationErr | null {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      return failure(`${method} does not accept \`${key}\` (accepts: ${allowed.length > 0 ? allowed.join(", ") : "no parameters"})`);
    }
  }
  return null;
}

function readInt(params: JsonObject, key: string, min: number, max: number): number | ValidationErr {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return failure(`\`${key}\` must be an integer`);
  }
  if (value < min || value > max) return failure(`\`${key}\` must be between ${min} and ${max}`);
  return value;
}

function readString(params: JsonObject, key: string, maxLength: number): string | ValidationErr {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) return failure(`\`${key}\` must be a non-empty string`);
  if (value.length > maxLength) return failure(`\`${key}\` must be at most ${maxLength} characters`);
  return value;
}

function isErr(value: unknown): value is ValidationErr {
  return typeof value === "object" && value !== null && "ok" in value && (value as { ok?: unknown }).ok === false;
}

/** Reads an integer that may be absent. Returns undefined when absent. */
function optionalInt(params: JsonObject, key: string, min: number, max: number): number | undefined | ValidationErr {
  if (params[key] === undefined) return undefined;
  return readInt(params, key, min, max);
}

function optionalBoolean(params: JsonObject, key: string): boolean | undefined | ValidationErr {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return failure(`\`${key}\` must be a boolean`);
  return value;
}

function parseTabIds(params: JsonObject, key: string): number[] | ValidationErr {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) return failure(`\`${key}\` must be a non-empty array of tab ids`);
  if (value.length > TAB_BATCH_MAX) return failure(`\`${key}\` accepts at most ${TAB_BATCH_MAX} tab ids`);
  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
      return failure(`\`${key}\` must contain only non-negative integers`);
    }
    if (ids.includes(entry)) return failure(`\`${key}\` must not repeat a tab id`);
    ids.push(entry);
  }
  return ids;
}

/**
 * Only schemes a page can actually be, and that an agent may drive. `chrome://`
 * tabs can be listed and closed but not navigated to a scriptable state, so they
 * are refused here rather than failing later in a confusing way.
 *
 * `data:` is deliberately absent: Chrome refuses a background navigation *to* a
 * data: URL ("not allowed to navigate top frame to data URL"), and a method that
 * accepts a URL the browser will silently ignore is worse than one that refuses it.
 *
 * `file:` is absent too (ADR 0005): with file-URL access on, an agent could open
 * and read any local file — SSH keys, the bridge token — through page.getText.
 */
const NAVIGABLE_SCHEMES = ["http:", "https:", "about:"];

export function isNavigableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return NAVIGABLE_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/** `tabs.list` — every tab, or one window's / one group's. */
export function parseListParams(params: JsonObject | undefined): Validation<ListParams> {
  const object = params ?? {};
  const unknown = rejectUnknownKeys(object, ["groupId", "windowId", "limit"], "tabs.list");
  if (unknown) return unknown;
  const groupId = optionalInt(object, "groupId", -1, Number.MAX_SAFE_INTEGER);
  if (isErr(groupId)) return groupId;
  const windowId = optionalInt(object, "windowId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(windowId)) return windowId;
  const limit = object["limit"] === undefined ? TAB_LIMIT_DEFAULT : readInt(object, "limit", 1, TAB_LIMIT_MAX);
  if (isErr(limit)) return limit;
  const result: ListParams = { limit };
  if (groupId !== undefined) result.groupId = groupId;
  if (windowId !== undefined) result.windowId = windowId;
  return { ok: true, value: result };
}

/** `tabs.query` — a predicate, never "the current tab". */
export function parseQueryParams(params: JsonObject | undefined): Validation<TabQuery> {
  if (params === undefined) return failure("tabs.query needs at least one predicate");
  const unknown = rejectUnknownKeys(
    params,
    ["urlPattern", "titleContains", "groupId", "windowId", "active", "pinned", "limit"],
    "tabs.query",
  );
  if (unknown) return unknown;
  const query: TabQuery = { limit: TAB_LIMIT_DEFAULT };
  if (params["urlPattern"] !== undefined) {
    const urlPattern = readString(params, "urlPattern", MAX_URL_LENGTH);
    if (isErr(urlPattern)) return urlPattern;
    query.urlPattern = urlPattern;
  }
  if (params["titleContains"] !== undefined) {
    const titleContains = readString(params, "titleContains", MAX_URL_LENGTH);
    if (isErr(titleContains)) return titleContains;
    query.titleContains = titleContains;
  }
  const groupId = optionalInt(params, "groupId", -1, Number.MAX_SAFE_INTEGER);
  if (isErr(groupId)) return groupId;
  if (groupId !== undefined) query.groupId = groupId;
  const windowId = optionalInt(params, "windowId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(windowId)) return windowId;
  if (windowId !== undefined) query.windowId = windowId;
  const active = optionalBoolean(params, "active");
  if (isErr(active)) return active;
  if (active !== undefined) query.active = active;
  const pinned = optionalBoolean(params, "pinned");
  if (isErr(pinned)) return pinned;
  if (pinned !== undefined) query.pinned = pinned;
  if (params["limit"] !== undefined) {
    const limit = readInt(params, "limit", 1, TAB_LIMIT_MAX);
    if (isErr(limit)) return limit;
    query.limit = limit;
  }
  const predicates = [query.urlPattern, query.titleContains, query.groupId, query.windowId, query.active, query.pinned];
  if (predicates.every((value) => value === undefined)) {
    return failure("tabs.query needs at least one predicate");
  }
  return { ok: true, value: query };
}

/** `tabs.navigate` — explicit tab, explicit URL, nothing inferred. */
export function parseNavigateParams(params: JsonObject | undefined): Validation<NavigateParams> {
  if (params === undefined) return failure("tabs.navigate needs `tabId` and `url`");
  const unknown = rejectUnknownKeys(params, ["tabId", "url"], "tabs.navigate");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const url = readString(params, "url", MAX_URL_LENGTH);
  if (isErr(url)) return url;
  if (!isNavigableUrl(url)) return failure("`url` must be an absolute http:, https: or about: URL");
  return { ok: true, value: { tabId, url } };
}

/**
 * `tabs.create` — open a page the user has not already opened.
 *
 * Exists so a flow that needs a new page does not have to leave the bridge for
 * AppleScript, which raises Chrome and gives up the no-focus-theft guarantee.
 * `background` defaults to **true**: the whole point is that opening a tab must not
 * pull the window in front of the human. A caller that wants the tab focused asks
 * for it explicitly.
 */
export function parseCreateParams(params: JsonObject | undefined): Validation<CreateParams> {
  if (params === undefined) return failure("tabs.create needs `url`");
  const unknown = rejectUnknownKeys(params, ["url", "windowId", "background", "pinned"], "tabs.create");
  if (unknown) return unknown;
  const url = readString(params, "url", MAX_URL_LENGTH);
  if (isErr(url)) return url;
  if (!isNavigableUrl(url)) return failure("`url` must be an absolute http:, https: or about: URL");
  const value: CreateParams = { url };
  if (params["windowId"] !== undefined) {
    const windowId = readInt(params, "windowId", -1, Number.MAX_SAFE_INTEGER);
    if (isErr(windowId)) return windowId;
    value.windowId = windowId;
  }
  const background = optionalBoolean(params, "background");
  if (isErr(background)) return background;
  if (background !== undefined) value.background = background;
  const pinned = optionalBoolean(params, "pinned");
  if (isErr(pinned)) return pinned;
  if (pinned !== undefined) value.pinned = pinned;
  return { ok: true, value };
}

/** `tabs.group` — join the marker, optionally an explicit group id. */
export function parseGroupParams(params: JsonObject | undefined): Validation<GroupParams> {
  if (params === undefined) return failure("tabs.group needs `tabIds`");
  const unknown = rejectUnknownKeys(params, ["tabIds", "groupId"], "tabs.group");
  if (unknown) return unknown;
  const tabIds = parseTabIds(params, "tabIds");
  if (isErr(tabIds)) return tabIds;
  const groupId = optionalInt(params, "groupId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(groupId)) return groupId;
  const value: GroupParams = { tabIds };
  if (groupId !== undefined) value.groupId = groupId;
  return { ok: true, value };
}

/** `tabs.ungroup` — leave the marker; the tab itself stays open. */
export function parseUngroupParams(params: JsonObject | undefined): Validation<{ tabIds: number[] }> {
  if (params === undefined) return failure("tabs.ungroup needs `tabIds`");
  const unknown = rejectUnknownKeys(params, ["tabIds"], "tabs.ungroup");
  if (unknown) return unknown;
  const tabIds = parseTabIds(params, "tabIds");
  if (isErr(tabIds)) return tabIds;
  return { ok: true, value: { tabIds } };
}

/** `tabs.close` — one explicit tab. */
export function parseCloseParams(params: JsonObject | undefined): Validation<{ tabId: number }> {
  if (params === undefined) return failure("tabs.close needs `tabId`");
  const unknown = rejectUnknownKeys(params, ["tabId"], "tabs.close");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  return { ok: true, value: { tabId } };
}

/**
 * `tabs.activate` — make a tab the active tab of its window.
 *
 * Deliberately not called "focus": selecting a tab does not raise its window. That
 * matters because the product rule is that nothing steals the owner's attention,
 * and because another tool driving the same Chrome (cua-driver) can only see the
 * active tab of a window. `focusWindow` is the explicit opt-in to raising it.
 */
export function parseActivateParams(params: JsonObject | undefined): Validation<{ tabId: number; focusWindow: boolean }> {
  if (params === undefined) return failure("tabs.activate needs `tabId`");
  const unknown = rejectUnknownKeys(params, ["tabId", "focusWindow"], "tabs.activate");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const focusWindow = optionalBoolean(params, "focusWindow");
  if (isErr(focusWindow)) return focusWindow;
  return { ok: true, value: { tabId, focusWindow: focusWindow === true } };
}

/** `session.start` — begin a marked session; tabs are added by `tabs.group` or on navigate. */
export function parseSessionStartParams(params: JsonObject | undefined): Validation<{ tabIds?: number[] }> {
  const object = params ?? {};
  const unknown = rejectUnknownKeys(object, ["tabIds"], "session.start");
  if (unknown) return unknown;
  if (object["tabIds"] === undefined) return { ok: true, value: {} };
  const tabIds = parseTabIds(object, "tabIds");
  if (isErr(tabIds)) return tabIds;
  return { ok: true, value: { tabIds } };
}

/* ------------------------------------------------------------------ */
/* M2 — reading a tab that is not in front                            */
/* ------------------------------------------------------------------ */

/** Bound on the accessibility tree we hand back: nodes, depth and text. */
export const AX_NODE_LIMIT_DEFAULT = 400;
export const AX_NODE_LIMIT_MAX = 4000;
export const AX_TEXT_LIMIT_DEFAULT = 20_000;
export const AX_TEXT_LIMIT_MAX = 200_000;
export const AX_NAME_MAX = 300;
export const AX_VALUE_MAX = 300;
export const AX_MAX_DEPTH = 60;

/**
 * One accessibility node, flattened. `nodeId` is the backend DOM node id when
 * Chrome gives us one: it is what `page.click` will address in M3, so it has to
 * survive the trip, and it has to be `null` rather than invented when it does not
 * exist.
 */
export interface AxNode {
  nodeId: number | null;
  role: string;
  name: string;
  value: string | null;
  description: string | null;
  /**
   * Index into the reply's `frames` when the node came from a child frame, null
   * for the tab's own document. A node from a frame has no usable `nodeId`:
   * address it with `selector` instead, which resolves across frames.
   */
  frame?: number | null;
  /** A CSS selector that is unique in the node's own frame, when known. */
  selector?: string | null;
  /** False for a node that is present but not rendered. */
  visible: boolean;
  disabled: boolean;
  focused: boolean;
  /**
   * Checked state for a checkbox, radio or switch; `null` for every other role.
   *
   * Tri-state on purpose: `false` means "a control that is not checked" and `null`
   * means "not a checkable control at all". Reporting `false` for a plain button
   * would invite a caller to read a state the node cannot have.
   */
  checked: boolean | null;
  /** Bounds in CSS pixels, or null when the node has no box. */
  bounds: { x: number; y: number; width: number; height: number } | null;
  childCount: number;
}

export interface AxReadResult {
  tabId: number;
  url: string | null;
  title: string | null;
  /**
   * Bumped whenever the tab's document changes. A `nodeId` is only valid within
   * the document that produced it, so a caller comparing epochs can tell that a
   * node it holds is stale instead of clicking the wrong thing.
   */
  documentEpoch: number;
  nodes: AxNode[];
  /** Total nodes Chrome returned, before the limit. */
  totalNodes: number;
  truncated: boolean;
  /** How the tree was obtained: `debugger` (CDP) or `scripting` (DOM fallback). */
  source: "debugger" | "scripting";
  /**
   * Every frame that was read, in order. Admin portals put their content in an
   * iframe, so a read that named no frames would look complete while being empty.
   */
  frames?: Array<{ index: number; url: string | null; title: string | null; nodes: number; source: "debugger" | "scripting" }>;
  /** Frames that could not be read, with the reason. Never silently dropped. */
  framesNotRead?: Array<{ url: string | null; reason: string }>;
}

export interface TextResult {
  tabId: number;
  url: string | null;
  title: string | null;
  documentEpoch: number;
  text: string;
  /** Length of the full page text, before any truncation. */
  length: number;
  truncated: boolean;
  source: "scripting";
  /** Frames whose text is included, in order (the tab's own document first). */
  frames?: Array<{ index: number; url: string | null; title: string | null; characters: number }>;
  framesNotRead?: Array<{ url: string | null; reason: string }>;
}

export interface ScreenshotResult {
  tabId: number;
  url: string | null;
  documentEpoch: number;
  /** Base64 PNG. Bounded: at most `MAX_SCREENSHOT_BASE64` characters. */
  png: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /**
   * True when the capture is byte-identical to the previous capture of the same
   * tab taken before a DOM change — i.e. Chrome returned a stale composited
   * frame because the tab is in the background. Honest rather than silent.
   */
  possiblyStale: boolean;
  source: "debugger";
}

/** A 4K PNG stays under this; anything larger is refused rather than truncated. */
export const MAX_SCREENSHOT_BASE64 = 6_000_000;

export interface ReadParams {
  tabId: number;
  limit: number;
  includeInvisible: boolean;
}

export interface TextParams {
  tabId: number;
  limit: number;
}

export interface ScreenshotParams {
  tabId: number;
  /** Compare against the previous capture of this tab to detect a stale frame. */
  detectStale: boolean;
}

/** `page.readAX` — the accessibility tree of one explicit tab. */
export function parseReadAxParams(params: JsonObject | undefined): Validation<ReadParams> {
  if (params === undefined) return failure("page.readAX needs `tabId`");
  const unknown = rejectUnknownKeys(params, ["tabId", "limit", "includeInvisible"], "page.readAX");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const limit = params["limit"] === undefined ? AX_NODE_LIMIT_DEFAULT : readInt(params, "limit", 1, AX_NODE_LIMIT_MAX);
  if (isErr(limit)) return limit;
  const includeInvisible = optionalBoolean(params, "includeInvisible");
  if (isErr(includeInvisible)) return includeInvisible;
  return { ok: true, value: { tabId, limit, includeInvisible: includeInvisible === true } };
}

/** `page.getText` — rendered text of one explicit tab. */
export function parseGetTextParams(params: JsonObject | undefined): Validation<TextParams> {
  if (params === undefined) return failure("page.getText needs `tabId`");
  const unknown = rejectUnknownKeys(params, ["tabId", "limit"], "page.getText");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const limit = params["limit"] === undefined ? AX_TEXT_LIMIT_DEFAULT : readInt(params, "limit", 1, AX_TEXT_LIMIT_MAX);
  if (isErr(limit)) return limit;
  return { ok: true, value: { tabId, limit } };
}

/** `page.screenshot` — a PNG of one explicit tab, never of the window. */
export function parseScreenshotParams(params: JsonObject | undefined): Validation<ScreenshotParams> {
  if (params === undefined) return failure("page.screenshot needs `tabId`");
  const unknown = rejectUnknownKeys(params, ["tabId", "detectStale"], "page.screenshot");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const detectStale = optionalBoolean(params, "detectStale");
  if (isErr(detectStale)) return detectStale;
  return { ok: true, value: { tabId, detectStale: detectStale === true } };
}

/* ------------------------------------------------------------------ */
/* M3 — acting on a tab that is not in front                          */
/* ------------------------------------------------------------------ */

/**
 * How a command names what it acts on. An AX node id is preferred (it survives
 * reflows and is what `page.readAX` returned); a CSS selector is the fallback for
 * a caller that has not read the tree; coordinates are the last resort for a
 * canvas or an element Chrome cannot describe.
 */
export interface ActionTarget {
  nodeId?: number;
  selector?: string;
  x?: number;
  y?: number;
}

export const SELECTOR_MAX = 500;
export const TYPE_TEXT_MAX = 20_000;
export const UPLOAD_FILES_MAX = 20;
export const WAIT_TIMEOUT_DEFAULT = 10_000;
export const WAIT_TIMEOUT_MAX = 60_000;

function parseTarget(params: JsonObject, method: string): ActionTarget | ValidationErr {
  const has = (key: string): boolean => params[key] !== undefined;
  const kinds = ["nodeId", "selector"].filter(has);
  const hasCoords = has("x") || has("y");
  if (kinds.length === 0 && !hasCoords) {
    return failure(`${method} needs a target: \`nodeId\`, \`selector\`, or \`x\` and \`y\``);
  }
  if (kinds.length > 1 || (kinds.length === 1 && hasCoords)) {
    return failure(`${method} accepts one target kind, not several`);
  }
  if (hasCoords && !(has("x") && has("y"))) return failure(`${method} needs both \`x\` and \`y\``);

  const target: ActionTarget = {};
  if (has("nodeId")) {
    const nodeId = readInt(params, "nodeId", 0, Number.MAX_SAFE_INTEGER);
    if (isErr(nodeId)) return nodeId;
    target.nodeId = nodeId;
  }
  if (has("selector")) {
    const selector = readString(params, "selector", SELECTOR_MAX);
    if (isErr(selector)) return selector;
    target.selector = selector;
  }
  if (hasCoords) {
    const x = readInt(params, "x", 0, 100_000);
    if (isErr(x)) return x;
    const y = readInt(params, "y", 0, 100_000);
    if (isErr(y)) return y;
    target.x = x;
    target.y = y;
  }
  return target;
}

function isTarget(value: unknown): value is ActionTarget {
  return typeof value === "object" && value !== null && !("ok" in value);
}

/**
 * How pointer input reaches the page.
 *
 * `auto` decides from the tab's own `document.visibilityState`: a visible tab gets
 * real CDP mouse events (the browser's own input pipeline), and a hidden tab gets
 * events dispatched inside the page, because Chrome does not ack
 * `Input.dispatchMouseEvent` for a renderer it is not compositing — the command
 * then times out with the click never applied. Keyboard input and DOM commands
 * are acked on a different path and work on a hidden tab, which is why a
 * background tab could be typed into but not clicked.
 *
 * The other two values exist for a caller that knows better than the guess.
 */
export type InputRoute = "auto" | "cdp" | "scripted";

export interface ClickParams {
  tabId: number;
  target: ActionTarget;
  /** Left unless said otherwise; `right` is what a context menu needs. */
  button: "left" | "right" | "middle";
  inputRoute: InputRoute;
}

export interface TypeParams {
  tabId: number;
  target: ActionTarget;
  text: string;
  /** Clear the field first. */
  clear: boolean;
  pressEnter: boolean;
  inputRoute: InputRoute;
}

export interface KeyParams {
  tabId: number;
  key: string;
  modifiers: string[];
}

/**
 * `page.scroll` needs no target. Scrolling is done inside the page (an element's
 * scrollable ancestor, or the document), so it works on a background tab where
 * `Input.dispatchMouseEvent` (wheel) does not.
 */
export interface ScrollParams {
  tabId: number;
  /** Optional: a node whose scrollable ancestor should move, or a point to hit-test. */
  target?: ActionTarget;
  deltaX: number;
  deltaY: number;
}

export interface SelectParams {
  tabId: number;
  target: ActionTarget;
  value: string;
}

export interface UploadParams {
  tabId: number;
  target: ActionTarget;
  files: string[];
}

export interface DownloadParams {
  tabId: number;
  target: ActionTarget;
  timeoutMs: number;
}

export interface WaitForParams {
  tabId: number;
  selector?: string;
  text?: string;
  urlIncludes?: string;
  timeoutMs: number;
}

export interface EvaluateParams {
  tabId: number;
  expression: string;
  awaitPromise: boolean;
}

const MODIFIERS = ["alt", "ctrl", "meta", "shift"] as const;

const INPUT_ROUTES = ["auto", "cdp", "scripted"] as const;

function parseInputRoute(params: JsonObject, method: string): InputRoute | ValidationErr {
  const value = params["inputRoute"];
  if (value === undefined) return "auto";
  if (typeof value !== "string" || !(INPUT_ROUTES as readonly string[]).includes(value)) {
    return failure(`${method} accepts \`inputRoute\` ${INPUT_ROUTES.join(", ")}`);
  }
  return value as InputRoute;
}

export function parseClickParams(params: JsonObject | undefined): Validation<ClickParams> {
  if (params === undefined) return failure("page.click needs `tabId` and a target");
  const unknown = rejectUnknownKeys(params, ["tabId", "nodeId", "selector", "x", "y", "button", "inputRoute"], "page.click");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const target = parseTarget(params, "page.click");
  if (isErr(target)) return target;
  const button = params["button"] ?? "left";
  if (button !== "left" && button !== "right" && button !== "middle") {
    return failure("`button` must be left, right or middle");
  }
  const inputRoute = parseInputRoute(params, "page.click");
  if (isErr(inputRoute)) return inputRoute;
  return { ok: true, value: { tabId, target, button, inputRoute } };
}

export function parseTypeParams(params: JsonObject | undefined): Validation<TypeParams> {
  if (params === undefined) return failure("page.type needs `tabId`, a target and `text`");
  const unknown = rejectUnknownKeys(
    params,
    ["tabId", "nodeId", "selector", "x", "y", "text", "clear", "pressEnter", "inputRoute"],
    "page.type",
  );
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const target = parseTarget(params, "page.type");
  if (isErr(target)) return target;
  const text = params["text"];
  if (typeof text !== "string") return failure("`text` must be a string");
  if (text.length > TYPE_TEXT_MAX) return failure(`\`text\` must be at most ${TYPE_TEXT_MAX} characters`);
  const clear = optionalBoolean(params, "clear");
  if (isErr(clear)) return clear;
  const pressEnter = optionalBoolean(params, "pressEnter");
  if (isErr(pressEnter)) return pressEnter;
  const inputRoute = parseInputRoute(params, "page.type");
  if (isErr(inputRoute)) return inputRoute;
  return {
    ok: true,
    value: { tabId, target, text, clear: clear === true, pressEnter: pressEnter === true, inputRoute },
  };
}

export function parseKeyParams(params: JsonObject | undefined): Validation<KeyParams> {
  if (params === undefined) return failure("page.key needs `tabId` and `key`");
  const unknown = rejectUnknownKeys(params, ["tabId", "key", "modifiers"], "page.key");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const key = readString(params, "key", 32);
  if (isErr(key)) return key;
  const modifiers: string[] = [];
  const raw = params["modifiers"];
  if (raw !== undefined) {
    if (!Array.isArray(raw)) return failure("`modifiers` must be an array of strings");
    for (const entry of raw) {
      if (typeof entry !== "string" || !(MODIFIERS as readonly string[]).includes(entry)) {
        return failure(`\`modifiers\` accepts only ${MODIFIERS.join(", ")}`);
      }
      if (!modifiers.includes(entry)) modifiers.push(entry);
    }
  }
  return { ok: true, value: { tabId, key, modifiers } };
}

export function parseScrollParams(params: JsonObject | undefined): Validation<ScrollParams> {
  if (params === undefined) return failure("page.scroll needs `tabId` and a delta to scroll by");
  const unknown = rejectUnknownKeys(params, ["tabId", "nodeId", "selector", "x", "y", "deltaX", "deltaY"], "page.scroll");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;

  // A scroll target is optional: without one, the document (or the largest
  // scrollable container) moves. With one, the point or the element picks which
  // container moves, and the page is not left to guess.
  const hasAnyTarget = params["nodeId"] !== undefined || params["selector"] !== undefined || params["x"] !== undefined || params["y"] !== undefined;
  let target: ActionTarget | undefined;
  if (hasAnyTarget) {
    const parsed = parseTarget(params, "page.scroll");
    if (isErr(parsed)) return parsed;
    target = parsed;
  }

  const deltaY = params["deltaY"] === undefined ? 0 : readInt(params, "deltaY", -100_000, 100_000);
  if (isErr(deltaY)) return deltaY;
  const deltaX = params["deltaX"] === undefined ? 0 : readInt(params, "deltaX", -100_000, 100_000);
  if (isErr(deltaX)) return deltaX;
  if (deltaX === 0 && deltaY === 0) return failure("page.scroll needs `deltaX` or `deltaY` to be non-zero");
  return { ok: true, value: { tabId, ...(target === undefined ? {} : { target }), deltaX, deltaY } };
}

export function parseSelectParams(params: JsonObject | undefined): Validation<SelectParams> {
  if (params === undefined) return failure("page.select needs `tabId`, a target and `value`");
  const unknown = rejectUnknownKeys(params, ["tabId", "nodeId", "selector", "x", "y", "value"], "page.select");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const target = parseTarget(params, "page.select");
  if (isErr(target)) return target;
  const value = params["value"];
  if (typeof value !== "string") return failure("`value` must be a string");
  if (value.length > SELECTOR_MAX) return failure(`\`value\` must be at most ${SELECTOR_MAX} characters`);
  return { ok: true, value: { tabId, target, value } };
}

export function parseUploadParams(params: JsonObject | undefined): Validation<UploadParams> {
  if (params === undefined) return failure("page.upload needs `tabId`, a target and `files`");
  const unknown = rejectUnknownKeys(params, ["tabId", "nodeId", "selector", "x", "y", "files"], "page.upload");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const target = parseTarget(params, "page.upload");
  if (isErr(target)) return target;
  const raw = params["files"];
  if (!Array.isArray(raw) || raw.length === 0) return failure("`files` must be a non-empty array of paths");
  if (raw.length > UPLOAD_FILES_MAX) return failure(`\`files\` accepts at most ${UPLOAD_FILES_MAX} paths`);
  const files: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) return failure("`files` must contain paths");
    if (entry.length > MAX_URL_LENGTH) return failure(`a path in \`files\` is too long`);
    files.push(entry);
  }
  return { ok: true, value: { tabId, target, files } };
}

export function parseDownloadParams(params: JsonObject | undefined): Validation<DownloadParams> {
  if (params === undefined) return failure("page.download needs `tabId` and a target");
  const unknown = rejectUnknownKeys(params, ["tabId", "nodeId", "selector", "x", "y", "timeoutMs"], "page.download");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const target = parseTarget(params, "page.download");
  if (isErr(target)) return target;
  const timeoutMs = params["timeoutMs"] === undefined ? WAIT_TIMEOUT_DEFAULT : readInt(params, "timeoutMs", 100, WAIT_TIMEOUT_MAX);
  if (isErr(timeoutMs)) return timeoutMs;
  return { ok: true, value: { tabId, target, timeoutMs } };
}

export function parseWaitForParams(params: JsonObject | undefined): Validation<WaitForParams> {
  if (params === undefined) return failure("page.waitFor needs `tabId` and a condition");
  const unknown = rejectUnknownKeys(params, ["tabId", "selector", "text", "urlIncludes", "timeoutMs"], "page.waitFor");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const value: WaitForParams = { tabId, timeoutMs: WAIT_TIMEOUT_DEFAULT };
  if (params["selector"] !== undefined) {
    const selector = readString(params, "selector", SELECTOR_MAX);
    if (isErr(selector)) return selector;
    value.selector = selector;
  }
  if (params["text"] !== undefined) {
    const text = readString(params, "text", MAX_URL_LENGTH);
    if (isErr(text)) return text;
    value.text = text;
  }
  if (params["urlIncludes"] !== undefined) {
    const urlIncludes = readString(params, "urlIncludes", MAX_URL_LENGTH);
    if (isErr(urlIncludes)) return urlIncludes;
    value.urlIncludes = urlIncludes;
  }
  if (value.selector === undefined && value.text === undefined && value.urlIncludes === undefined) {
    return failure("page.waitFor needs at least one of `selector`, `text`, `urlIncludes`");
  }
  if (params["timeoutMs"] !== undefined) {
    const timeoutMs = readInt(params, "timeoutMs", 100, WAIT_TIMEOUT_MAX);
    if (isErr(timeoutMs)) return timeoutMs;
    value.timeoutMs = timeoutMs;
  }
  return { ok: true, value };
}

export function parseEvaluateParams(params: JsonObject | undefined): Validation<EvaluateParams> {
  if (params === undefined) return failure("page.evaluate needs `tabId` and `expression`");
  const unknown = rejectUnknownKeys(params, ["tabId", "expression", "awaitPromise"], "page.evaluate");
  if (unknown) return unknown;
  const tabId = readInt(params, "tabId", 0, Number.MAX_SAFE_INTEGER);
  if (isErr(tabId)) return tabId;
  const expression = readString(params, "expression", TYPE_TEXT_MAX);
  if (isErr(expression)) return expression;
  const awaitPromise = optionalBoolean(params, "awaitPromise");
  if (isErr(awaitPromise)) return awaitPromise;
  return { ok: true, value: { tabId, expression, awaitPromise: awaitPromise === true } };
}

/** `session.status` — takes no parameters, and says so rather than ignoring them. */
export function parseSessionStatusParams(params: JsonObject | undefined): Validation<Record<string, never>> {
  const object = params ?? {};
  const unknown = rejectUnknownKeys(object, [], "session.status");
  if (unknown) return unknown;
  return { ok: true, value: {} };
}

/** `session.end` — ungroup everything the marker holds. Takes no parameters. */
export function parseSessionEndParams(params: JsonObject | undefined): Validation<Record<string, never>> {
  const object = params ?? {};
  const unknown = rejectUnknownKeys(object, [], "session.end");
  if (unknown) return unknown;
  return { ok: true, value: {} };
}

/**
 * The owner-controlled switch for `page.evaluate` (plan §5.1). Default off; only
 * a human flips it in the extension's options page. The agent may read it.
 */
export interface ExtensionSettingsView {
  evaluateEnabled: boolean;
  /** Always "human": the protocol cannot change a setting. */
  evaluateEnabledBy: "human";
}

export const EVALUATE_DISABLED_HINT = "Enable 'Allow page.evaluate' in the Ava extension settings";

/* ------------------------------------------------------------------ */
/* Handshake                                                          */
/* ------------------------------------------------------------------ */

/**
 * Close codes used by both sides. 4000-4999 is the application-private range.
 * The code is the contract; the reason string is for humans only.
 */
export const WS_CLOSE = {
  unauthorized: 4001,
  protocolMismatch: 4002,
  badOrigin: 4003,
  handshakeTimeout: 4008,
  replaced: 4009,
  malformed: 4010,
  /** Client-side close: the peer could not prove it holds the token (ADR 0005). */
  serverUnverified: 4011,
} as const;

export const HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * v2 handshake (ADR 0005), four frames on a fresh socket:
 *   client -> hello            { clientNonce }            (no token, no proof)
 *   server -> hello_challenge  { serverNonce, serverProof } (server proves first)
 *   client -> hello_auth       { clientProof }             (only after verifying)
 *   server -> hello_ok         { sessionId }
 * Neither side acts on the other's requests before the exchange completes.
 */
export interface ClientHello {
  type: "hello";
  protocolVersion: number;
  /** Fresh 32-byte base64url nonce. The token itself is never sent. */
  clientNonce: string;
  client: {
    name: string;
    version: string;
    extensionId?: string;
    /** True when this handshake follows a previous one in the same worker lifetime (MV3 resume). */
    resumed?: boolean;
  };
}

export interface ServerChallenge {
  type: "hello_challenge";
  serverNonce: string;
  /** HMAC(token, ws-server, clientNonce, serverNonce): the bridge proves it holds the token. */
  serverProof: string;
}

export interface ClientAuth {
  type: "hello_auth";
  /** HMAC(token, ws-client, clientNonce, serverNonce). */
  clientProof: string;
}

export interface ServerHelloOk {
  type: "hello_ok";
  protocolVersion: number;
  sessionId: string;
  server: { name: string; version: string };
}

export interface ServerHelloError {
  type: "hello_error";
  error: ErrorPayload;
}

export type ServerHello = ServerHelloOk | ServerHelloError;

/** Application-level liveness frame. Keeps the socket (and the MV3 worker) active. */
export interface PingFrame {
  type: "ping";
  seq: number;
}

export interface PongFrame {
  type: "pong";
  seq: number;
}

export type ControlFrame = PingFrame | PongFrame;

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

export interface ValidationOk<T> {
  ok: true;
  value: T;
}

export interface ValidationErr {
  ok: false;
  error: ErrorPayload;
}

export type Validation<T> = ValidationOk<T> | ValidationErr;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(message: string): ValidationErr {
  return { ok: false, error: makeError("invalid_request", message, false) };
}

export function makeError(
  code: ErrorCode,
  message: string,
  retryable: boolean = RETRYABLE_BY_DEFAULT[code],
  detail?: JsonObject,
): ErrorPayload {
  const payload: ErrorPayload = {
    code,
    message: message.slice(0, MAX_MESSAGE_LENGTH),
    retryable,
  };
  if (detail !== undefined) payload.detail = detail;
  return payload;
}

export function isErrorPayload(value: unknown): value is ErrorPayload {
  if (!isPlainObject(value)) return false;
  const code = value["code"];
  const message = value["message"];
  const retryable = value["retryable"];
  return (
    typeof code === "string" &&
    (ERROR_CODES as readonly string[]).includes(code) &&
    typeof message === "string" &&
    typeof retryable === "boolean"
  );
}

function validIdentifier(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Validate an incoming request envelope. Rejects (does not repair) bad shapes. */
export function parseRequestEnvelope(input: unknown): Validation<RequestEnvelope> {
  if (!isPlainObject(input)) return failure("message must be a JSON object");
  const id = input["id"];
  const method = input["method"];
  if (!validIdentifier(id, MAX_ID_LENGTH)) return failure("id must be a non-empty string");
  if (!validIdentifier(method, MAX_METHOD_LENGTH)) return failure("method must be a non-empty string");
  const params = input["params"];
  if (params !== undefined && !isPlainObject(params)) return failure("params must be an object when present");
  const envelope: RequestEnvelope = { id, method };
  if (params !== undefined) envelope.params = params as JsonObject;
  return { ok: true, value: envelope };
}

export function isResponseEnvelope(input: unknown): input is ResponseEnvelope {
  if (!isPlainObject(input)) return false;
  if (!validIdentifier(input["id"], MAX_ID_LENGTH)) return false;
  if (input["ok"] === true) return Object.hasOwn(input, "result");
  if (input["ok"] === false) return isErrorPayload(input["error"]);
  return false;
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Shape only: a hello from an older client (no nonce) still parses as far as its
 * version, so the bridge can answer `protocol_mismatch` instead of `malformed`.
 */
export function isClientHello(input: unknown): input is ClientHello {
  if (!isPlainObject(input) || input["type"] !== "hello") return false;
  if (typeof input["protocolVersion"] !== "number") return false;
  if (input["protocolVersion"] === PROTOCOL_VERSION) {
    if (typeof input["clientNonce"] !== "string" || !NONCE_PATTERN.test(input["clientNonce"])) return false;
  }
  const client = input["client"];
  if (!isPlainObject(client)) return false;
  return typeof client["name"] === "string" && typeof client["version"] === "string";
}

export function isServerChallenge(input: unknown): input is ServerChallenge {
  if (!isPlainObject(input) || input["type"] !== "hello_challenge") return false;
  return (
    typeof input["serverNonce"] === "string" &&
    NONCE_PATTERN.test(input["serverNonce"]) &&
    typeof input["serverProof"] === "string" &&
    NONCE_PATTERN.test(input["serverProof"])
  );
}

export function isClientAuth(input: unknown): input is ClientAuth {
  if (!isPlainObject(input) || input["type"] !== "hello_auth") return false;
  return typeof input["clientProof"] === "string" && NONCE_PATTERN.test(input["clientProof"]);
}

export function isServerHello(input: unknown): input is ServerHello {
  if (!isPlainObject(input)) return false;
  if (input["type"] === "hello_ok") {
    return typeof input["protocolVersion"] === "number" && typeof input["sessionId"] === "string";
  }
  if (input["type"] === "hello_error") return isErrorPayload(input["error"]);
  return false;
}

export function isControlFrame(input: unknown): input is ControlFrame {
  if (!isPlainObject(input)) return false;
  const type = input["type"];
  if (type !== "ping" && type !== "pong") return false;
  return typeof input["seq"] === "number";
}

export function okResponse(id: string, result: JsonValue): SuccessResponse {
  return { id, ok: true, result };
}

export function errorResponse(id: string, error: ErrorPayload): ErrorResponse {
  return { id, ok: false, error };
}

/**
 * M3: acting on a tab that is not in front.
 *
 * Input goes through CDP (`Input.dispatchMouseEvent`, `Input.insertText`,
 * `Input.dispatchKeyEvent`) because a background tab receives no OS events: the
 * page is rendered but not focused, so synthesized browser-level input is the only
 * thing that reaches it.
 *
 * Rules:
 *   - a target is resolved to a box before anything is dispatched. An AX node id
 *     is resolved through `DOM.getBoxModel`; a selector through `DOM.querySelector`
 *     on the document node; coordinates are used only when given;
 *   - the element is scrolled into view and re-measured before clicking, because a
 *     box measured off-screen is a click into nothing;
 *   - nothing is retried. A click that timed out may or may not have happened, and
 *     retrying a submit button is worse than reporting the ambiguity;
 *   - a JavaScript dialog is reported as `needs_human` rather than hanging: it
 *     blocks the renderer, so the command is answered instead of waiting.
 */

import {
  WAIT_TIMEOUT_DEFAULT,
  type ActionTarget,
  type ClickParams,
  type DownloadParams,
  type EvaluateParams,
  type InputRoute,
  type JsonObject,
  type JsonValue,
  type KeyParams,
  type ScrollParams,
  type SelectParams,
  type TypeParams,
  type UploadParams,
  type WaitForParams,
} from "@gb-ava/protocol";
import { clampText } from "./ax.js";
import { commandError } from "./errors.js";
import { ensureAttached, send, withChooserInterception } from "./debugger.js";
import { clickInFrame, findInFrames, focusInFrame, scrollInFrame, selectorInAnyFrame } from "./frames.js";
import { documentEpochFor } from "./read-ops.js";
import {
  chooserOpened,
  chooserResolved,
  clearSyntheticChooser,
  openChooser,
  openDialog,
  openRealChooser,
  recentDialog,
} from "./dialogs.js";

/** A box in CSS pixels, from `DOM.getBoxModel`. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResolvedTarget {
  box: Box;
  /** The CDP object id, when the target resolved to a node (needed for select/upload). */
  objectId?: string;
  backendNodeId?: number;
  /**
   * Set when the element lives in a child frame. A CDP session cannot reach an
   * out-of-process frame, so such an element is addressed by a selector inside its
   * own frame instead of by a box in the tab.
   */
  frameId?: number;
  frameUrl?: string;
  frameSelector?: string;
}

/** The session arms Page events on attach; this only guarantees a session exists. */
async function ensureSession(tabId: number): Promise<void> {
  await ensureAttached(tabId);
}

function assertNoDialog(tabId: number): void {
  const dialog = openDialog(tabId);
  if (dialog === null) return;
  throw commandError(
    "needs_human",
    `tab ${tabId} is showing a JavaScript ${dialog.type}: ${dialog.message.slice(0, 200)}`,
    false,
    { tabId, reason: "javascript_dialog", dialogType: dialog.type },
  );
}

export function currentDialog(tabId: number): { type: string; message: string } | null {
  return openDialog(tabId);
}

/* ------------------------------------------------------------------ */
/* Input routing                                                      */
/* ------------------------------------------------------------------ */

/**
 * A background tab does not get CDP mouse events applied: Chrome never acks
 * `Input.dispatchMouseEvent` for a renderer it is not compositing, so the command
 * times out and the click silently did not happen. Keyboard events, DOM commands
 * and `Runtime` calls are acked on a different path and work fine there — which is
 * why a background tab could be read and typed into but not clicked.
 *
 * So the route is chosen from observed state *before* dispatching, never by
 * retrying after a timeout (a retried click can submit twice):
 *   - visible tab  -> real CDP mouse events;
 *   - hidden tab   -> events dispatched inside the page, which the renderer's own
 *                     JS thread answers immediately and which frameworks handle
 *                     the same way they handle a real click.
 */
async function tabVisibility(tabId: number): Promise<"visible" | "hidden" | "unknown"> {
  try {
    const reply = await send<{ result?: { value?: unknown } }>(
      tabId,
      "Runtime.evaluate",
      { expression: "document.visibilityState", returnByValue: true },
      2_000,
    );
    const value = reply.result?.value;
    return value === "visible" || value === "hidden" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

interface InputPlan {
  route: "cdp" | "scripted";
  reason: string;
}

async function chooseInputPlan(tabId: number, requested: InputRoute): Promise<InputPlan> {
  if (requested === "cdp") return { route: "cdp", reason: "forced by inputRoute" };
  if (requested === "scripted") return { route: "scripted", reason: "forced by inputRoute" };

  // The page's own report is the strongest signal, but it is not the only one:
  // Chrome reports `visible` for the active tab of a window that is behind another
  // application, and that renderer may still not be compositing. So the CDP route
  // is used only when every signal agrees the tab is really in front, and the
  // in-page route otherwise. Being wrong towards `scripted` costs fidelity (no
  // browser-level hover or `:active` styling); being wrong towards `cdp` costs the
  // click itself.
  const visibility = await tabVisibility(tabId);
  // Only a definite "visible" earns the CDP route: a renderer slow enough to miss
  // the probe is exactly the one unlikely to ack a mouse event.
  if (visibility !== "visible") {
    return {
      route: "scripted",
      reason: `the page reports visibilityState ${visibility === "unknown" ? "(no answer)" : "hidden"}`,
    };
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab === null) throw commandError("not_found", `tab ${tabId} no longer exists`, false, { tabId });
  if (tab.active !== true) {
    return { route: "scripted", reason: "the tab is not the active tab in its window" };
  }
  const window = await chrome.windows.get(tab.windowId).catch(() => null);
  if (window === null || window.focused !== true) {
    return { route: "scripted", reason: "the tab's window is not focused" };
  }
  return { route: "cdp", reason: "the tab is active in a focused window and reports visible" };
}

/**
 * One click, dispatched inside the page. `this` must be the element.
 *
 * The full pointer/mouse sequence is sent because a framework that tracks pointer
 * state ignores a bare `click` event, and `click` itself is what runs the
 * element's default action (an anchor navigates, a submit button submits).
 */
const SCRIPTED_CLICK_FN = `function (button, buttons) {
  const el = this;
  if (el === null || el === undefined || el.nodeType !== 1) return { ok: false, reason: "target is not an element" };
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (error) { void error; }
  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  const base = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x, screenY: y, button: button,
  };
  const pointer = function (type, held) {
    return new PointerEvent(type, Object.assign({}, base, { buttons: held, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1 }));
  };
  const mouse = function (type, held) {
    return new MouseEvent(type, Object.assign({}, base, { buttons: held, detail: 1 }));
  };
  el.dispatchEvent(pointer("pointerover", 0));
  el.dispatchEvent(pointer("pointerenter", 0));
  el.dispatchEvent(mouse("mouseover", 0));
  el.dispatchEvent(mouse("mouseenter", 0));
  el.dispatchEvent(pointer("pointermove", 0));
  el.dispatchEvent(mouse("mousemove", 0));
  if (typeof el.focus === "function") { try { el.focus({ preventScroll: true }); } catch (error) { void error; } }
  el.dispatchEvent(pointer("pointerdown", buttons));
  el.dispatchEvent(mouse("mousedown", buttons));
  el.dispatchEvent(pointer("pointerup", 0));
  el.dispatchEvent(mouse("mouseup", 0));
  el.dispatchEvent(mouse("click", 0));
  if (button === 2) el.dispatchEvent(mouse("contextmenu", 0));
  return {
    ok: true,
    x: x,
    y: y,
    tag: el.tagName === undefined ? "" : String(el.tagName).toLowerCase(),
    // A synthetic click carries no user activation, so Chrome will not open the
    // file picker for one. Reporting the input lets the command record the chooser
    // the page is now waiting for, instead of pretending the click finished.
    fileInput: el.tagName === "INPUT" && String(el.type).toLowerCase() === "file",
    visibility: document.visibilityState,
  };
}`;

const BUTTON_NUMBER: Record<"left" | "right" | "middle", number> = { left: 0, middle: 1, right: 2 };
const BUTTON_BITS: Record<"left" | "right" | "middle", number> = { left: 1, middle: 4, right: 2 };

interface ScriptedClickResult {
  point: { x: number; y: number };
  tag: string;
  fileInput: boolean;
}

async function scriptedClick(tabId: number, resolved: ResolvedTarget, button: "left" | "right" | "middle"): Promise<ScriptedClickResult> {
  const number = BUTTON_NUMBER[button];
  const bits = BUTTON_BITS[button];
  const apply = (raw: unknown, how: string): ScriptedClickResult => {
    const record = (raw ?? {}) as { ok?: boolean; reason?: string; x?: number; y?: number; tag?: string; fileInput?: boolean };
    if (record.ok !== true) {
      throw commandError("not_found", `cannot click on tab ${tabId}: ${record.reason ?? "no element at the target"}`, false, {
        tabId,
        how,
      });
    }
    return { point: { x: record.x ?? 0, y: record.y ?? 0 }, tag: record.tag ?? "", fileInput: record.fileInput === true };
  };

  if (resolved.objectId !== undefined) {
    const reply = await send<{ result?: { value?: unknown } }>(tabId, "Runtime.callFunctionOn", {
      objectId: resolved.objectId,
      functionDeclaration: SCRIPTED_CLICK_FN,
      arguments: [{ value: number }, { value: bits }],
      returnByValue: true,
    });
    return apply(reply.result?.value, "element");
  }

  // A coordinates-only target: hit-test to find the element under the point, so
  // the click still goes through the page rather than the browser.
  const { x, y } = pointOf(resolved.box);
  const reply = await send<{ result?: { value?: unknown } }>(
    tabId,
    "Runtime.evaluate",
    {
      expression: `(${SCRIPTED_CLICK_FN}).call(document.elementFromPoint(${x}, ${y}), ${number}, ${bits})`,
      returnByValue: true,
    },
    5_000,
  );
  return apply(reply.result?.value, "hit-test");
}

/**
 * Scroll inside the page. No compositor input is involved, so this is the route
 * that works on a background tab — a wheel event dispatched through CDP is not.
 * `this` is the element whose scrollable ancestor should move, or absent for the
 * document / the page's own largest scroller.
 */
const SCROLL_FN = `function (deltaX, deltaY) {
  const scrolls = function (el) {
    if (el === null || el === undefined || el.nodeType !== 1) return false;
    const style = getComputedStyle(el);
    const overflow = style === null ? "" : (style.overflowY + " " + style.overflowX);
    return /(auto|scroll|overlay)/.test(overflow) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  };
  const nearest = function (start) {
    let node = start;
    while (node !== null && node !== undefined && node.nodeType === 1) {
      if (scrolls(node)) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  const pick = this !== null && this !== undefined && this.nodeType === 1 ? nearest(this) : (document.scrollingElement || document.documentElement);
  const describe = function (el) {
    if (el === document.scrollingElement || el === document.documentElement) return "document";
    return el.tagName.toLowerCase() + (el.id === "" ? "" : "#" + el.id);
  };
  const before = { top: pick.scrollTop, left: pick.scrollLeft };
  try { pick.scrollBy({ top: deltaY, left: deltaX, behavior: "instant" }); } catch (error) {
    pick.scrollTop = pick.scrollTop + deltaY;
    pick.scrollLeft = pick.scrollLeft + deltaX;
    void error;
  }
  const after = { top: pick.scrollTop, left: pick.scrollLeft };
  const maxScrollTop = Math.max(0, pick.scrollHeight - pick.clientHeight);
  const atLimit = (deltaY > 0 && after.top >= maxScrollTop - 1) || (deltaY < 0 && after.top <= 0);
  return {
    ok: true,
    container: describe(pick),
    before: before,
    after: after,
    moved: before.top !== after.top || before.left !== after.left,
    maxScrollTop: maxScrollTop,
    atLimit: atLimit,
    visibility: document.visibilityState,
  };
}`;


/**
 * A modal dialog blocks the renderer, so a CDP input command sent while one is
 * open never answers. Anything that hung while a dialog is up is reported as
 * `needs_human`, not as a timeout: the human has something to do.
 */
function blockedByDialog(tabId: number): never | void {
  const dialog = openDialog(tabId) ?? recentDialog(tabId);
  if (dialog === null) return;
  throw commandError(
    "needs_human",
    `tab ${tabId} is showing a JavaScript ${dialog.type}: ${dialog.message.slice(0, 200)}`,
    false,
    { tabId, reason: "javascript_dialog", dialogType: dialog.type },
  );
}

async function dispatchInput(tabId: number, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const payload = error instanceof Error && "payload" in error ? (error as { payload?: { code?: string } }).payload : undefined;
    if (payload?.code === "timeout") {
      blockedByDialog(tabId);
    }
    throw error;
  }
}

function boxFromQuad(quad: number[]): Box {
  const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

async function documentNodeId(tabId: number): Promise<number> {
  const doc = await send<{ root: { nodeId: number } }>(tabId, "DOM.getDocument", { depth: 0 });
  return doc.root.nodeId;
}

async function boxForBackendNode(tabId: number, backendNodeId: number): Promise<Box | null> {
  try {
    const model = await send<{ model?: { border: number[] } }>(tabId, "DOM.getBoxModel", { backendNodeId });
    const border = model.model?.border;
    return Array.isArray(border) && border.length === 8 ? boxFromQuad(border) : null;
  } catch {
    return null;
  }
}

/**
 * Describe the first few elements a selector matches, so an ambiguous-selector
 * refusal tells the caller *what* it collided with rather than only that it did.
 *
 * Each entry carries the same identity `page.select` reports on success, plus the
 * element's own text so a human-recognisable label is there too.
 */
async function describeSelectorMatches(
  tabId: number,
  selector: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  try {
    const root = await documentNodeId(tabId);
    const found = await send<{ nodeIds?: number[] }>(tabId, "DOM.querySelectorAll", { nodeId: root, selector });
    const nodeIds = (found.nodeIds ?? []).slice(0, limit);
    const described: Array<Record<string, unknown>> = [];
    for (const nodeId of nodeIds) {
      const asNode = await send<{ node?: { backendNodeId?: number } }>(tabId, "DOM.describeNode", { nodeId });
      const backendNodeId = asNode.node?.backendNodeId;
      if (backendNodeId === undefined) continue;
      const resolved = await send<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
      const objectId = resolved.object?.objectId;
      if (objectId === undefined) continue;
      const describedOne = await send<{ result?: { value?: unknown } }>(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          const el = this;
          const visible = !!(el.offsetParent || el.getClientRects().length);
          const text = (el.innerText || el.textContent || "").trim().slice(0, 80);
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            name: el.getAttribute("name") || null,
            ariaLabel: el.getAttribute("aria-label") || null,
            text: text.length > 0 ? text : null,
            visible,
          };
        }`,
        returnByValue: true,
      });
      const value = describedOne.result?.value;
      if (typeof value === "object" && value !== null) described.push(value as Record<string, unknown>);
    }
    return described;
  } catch {
    // Describing is best-effort: the refusal itself is what matters, and a failure
    // to enrich it must not turn into a different error.
    return [];
  }
}

async function boxForSelector(
  tabId: number,
  selector: string,
  options: { requireUnique?: boolean } = {},
): Promise<{ box: Box | null; backendNodeId: number }> {
  const root = await documentNodeId(tabId);
  let nodeId: number;
  try {
    // Count before resolving. `DOM.querySelector` returns only the first match, so
    // without this a selector matching several controls silently takes whichever
    // Chrome lists first — the theme picker instead of the contact picker.
    if (options.requireUnique === true) {
      const all = await send<{ nodeIds?: number[] }>(tabId, "DOM.querySelectorAll", { nodeId: root, selector });
      const count = (all.nodeIds ?? []).length;
      if (count > 1) {
        const matches = await describeSelectorMatches(tabId, selector, 5);
        throw commandError(
          "invalid_request",
          `${selector} matches ${count} elements; make the selector specific to one`,
          false,
          { tabId, selector, matchCount: count, matches: matches as unknown as JsonValue[] },
        );
      }
    }
    const found = await send<{ nodeId: number }>(tabId, "DOM.querySelector", { nodeId: root, selector });
    nodeId = found.nodeId;
  } catch (error) {
    // Only a protocol error we already classified (a timeout, a dead session) is
    // re-thrown as itself: it must not be reported as the caller's bad selector.
    if (error instanceof Error && "payload" in error) throw error;
    throw commandError("invalid_request", `selector is not valid CSS: ${selector}`, false, { selector, detail: (error as Error).message });
  }
  if (nodeId === 0) {
    throw commandError("not_found", `no element matches ${selector}`, false, { selector });
  }
  const described = await send<{ node?: { backendNodeId?: number } }>(tabId, "DOM.describeNode", { nodeId });
  const backendNodeId = described.node?.backendNodeId ?? 0;
  const box = backendNodeId === 0 ? null : await boxForBackendNode(tabId, backendNodeId);
  return { box, backendNodeId };
}

/**
 * The one frame that holds `selector`.
 *
 * A selector present in two frames is ambiguous: picking the first would click a
 * different element while answering `ok`, so it fails closed and lists the frames.
 */
async function frameTargetFor(
  tabId: number,
  selector: string,
): Promise<{ frameId: number; url: string; count: number } | null> {
  const matches = await findInFrames(tabId, selector);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw commandError(
      "invalid_request",
      `${selector} matches elements in ${matches.length} frames; make the selector specific to one`,
      false,
      { tabId, selector, frames: matches.map((match) => match.url) },
    );
  }
  return matches[0] ?? null;
}

/**
 * Resolve the target to a box, scrolling it into view first when it is a node:
 * an off-screen box would put the synthetic click somewhere else entirely.
 */
async function resolveTarget(
  tabId: number,
  target: ActionTarget,
  options: { requireBox?: boolean; requireUnique?: boolean } = {},
): Promise<ResolvedTarget> {
  const requireBox = options.requireBox !== false;
  if (target.x !== undefined && target.y !== undefined) {
    return { box: { x: target.x, y: target.y, width: 0, height: 0 } };
  }

  let backendNodeId: number;
  if (target.nodeId !== undefined) {
    backendNodeId = target.nodeId;
  } else if (target.selector !== undefined) {
    const topDocument = await boxForSelector(tabId, target.selector, {
      requireUnique: options.requireUnique === true,
    }).catch((error: unknown) => {
      const payload = error instanceof Error && "payload" in error ? (error as { payload: { code?: string } }).payload : undefined;
      // Only "not in this document" is worth a second look elsewhere: a timeout or
      // a dead session is a real failure and must not be reported as not_found.
      return payload?.code === "not_found" ? null : Promise.reject(error);
    });
    if (topDocument === null || topDocument.backendNodeId === 0) {
      // Not in the tab's own document: admin portals render their real content in
      // a frame, so look there before calling it missing.
      const framed = await frameTargetFor(tabId, target.selector);
      if (framed === null) {
        throw commandError("not_found", `no element matches ${target.selector} in the page or any frame`, false, {
          tabId,
          selector: target.selector,
        });
      }
      return {
        box: { x: 0, y: 0, width: 0, height: 0 },
        frameId: framed.frameId,
        frameUrl: framed.url,
        frameSelector: target.selector,
      };
    }
    backendNodeId = topDocument.backendNodeId;
  } else {
    throw commandError("invalid_request", "target is empty");
  }

  // Scroll into view, then measure: the first measurement may be off-screen.
  try {
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // A node with no box (a detached or display:none element) cannot be scrolled.
  }

  const box = await boxForBackendNode(tabId, backendNodeId);
  if (requireBox && (box === null || box.width <= 0 || box.height <= 0)) {
    // A hidden duplicate in the top document is routine (a mobile nav, a template
    // copy); the element the caller means may be the visible one in a frame.
    if (target.selector !== undefined) {
      const framed = await frameTargetFor(tabId, target.selector);
      if (framed !== null) {
        return {
          box: { x: 0, y: 0, width: 0, height: 0 },
          frameId: framed.frameId,
          frameUrl: framed.url,
          frameSelector: target.selector,
        };
      }
    }
    throw commandError("not_found", `target has no box on tab ${tabId} (hidden, detached, or zero-sized)`, false, {
      tabId,
    });
  }
  const effectiveBox: Box = box ?? { x: 0, y: 0, width: 0, height: 0 };

  let objectId: string | undefined;
  try {
    const resolved = await send<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
    objectId = resolved.object?.objectId;
  } catch {
    // Only select/upload need the object; a click does not.
  }
  return { box: effectiveBox, objectId, backendNodeId };
}

function pointOf(box: Box): { x: number; y: number } {
  // Coordinates-only targets have no extent: use the point itself.
  const width = box.width === 0 ? 0 : box.width;
  const height = box.height === 0 ? 0 : box.height;
  return { x: Math.round(box.x + width / 2), y: Math.round(box.y + height / 2) };
}

async function mouseClick(tabId: number, point: { x: number; y: number }, button: "left" | "right" | "middle"): Promise<string[]> {
  const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
  // Which events the renderer actually acked. A timeout after `mousePressed` was
  // acked but `mouseReleased` was not is a click that probably happened; a timeout
  // on `mouseMoved` is a click that certainly did not. Reporting the list lets the
  // caller decide instead of re-clicking blindly.
  const acked: string[] = [];
  const step = async (params: Record<string, unknown>): Promise<void> => {
    await send(tabId, "Input.dispatchMouseEvent", params);
    acked.push(String(params["type"]));
  };
  try {
    await step({ type: "mouseMoved", x: point.x, y: point.y, button: "none" });
    await step({ type: "mousePressed", x: point.x, y: point.y, button, buttons, clickCount: 1 });
    await step({ type: "mouseReleased", x: point.x, y: point.y, button, buttons: 0, clickCount: 1 });
  } catch (error) {
    if (error instanceof Error && "payload" in error) {
      const payload = (error as { payload: { code?: string; message?: string; detail?: Record<string, unknown> } }).payload;
      if (payload.code === "timeout") {
        // Re-thrown with what did land, so "unknown" is not the whole answer.
        throw commandError("timeout", payload.message ?? `tab ${tabId} did not ack the click`, false, {
          tabId,
          method: "Input.dispatchMouseEvent",
          acked,
          documentEpoch: documentEpochFor(tabId),
          hint: "Re-read the page before clicking again: a partially acked click may have landed",
        });
      }
    }
    throw error;
  }
  return acked;
}

export async function clickCommand(params: ClickParams): Promise<JsonObject> {
  const { tabId, target, button, inputRoute } = params;
  assertNoDialog(tabId);
  // A synthetic chooser is a one-shot hint from the previous click (a synthetic
  // click cannot open a real picker); it must not turn every later click into
  // needs_human, and it must not keep file-chooser interception armed.
  clearSyntheticChooser(tabId);
  await ensureSession(tabId);
  const resolved = await resolveTarget(tabId, target);
  // A frame target is clicked inside its own frame: a CDP session cannot reach an
  // out-of-process frame, and box coordinates from a child frame are relative to
  // that frame rather than to the tab, so a coordinate click would land elsewhere.
  const inFrame = resolved.frameId !== undefined;
  const plan = inFrame ? { route: "frame" as const, reason: `element is in frame ${resolved.frameUrl ?? ""}` } : await chooseInputPlan(tabId, inputRoute);
  let point = pointOf(resolved.box);
  let clickedTag: string | null = null;
  // A click that opens a modal dialog can leave the release queued behind it and
  // never answer. That is not a failure: the press landed, and the thing the
  // caller must do next is the dialog.
  let queuedBehindDialog = false;
  try {
    await withChooserInterception(
      tabId,
      () => openRealChooser(tabId) !== null,
      async () => {
        if (resolved.frameId !== undefined) {
          const outcome = await clickInFrame(tabId, resolved.frameId, resolved.frameSelector!, button);
          if (outcome.ok !== true) {
            throw commandError("not_found", outcome.reason ?? "the element could not be clicked in its frame", false, {
              tabId,
              frame: resolved.frameUrl ?? null,
            });
          }
          point = { x: outcome.x ?? 0, y: outcome.y ?? 0 };
          clickedTag = outcome.tag ?? null;
          if (outcome.fileInput === true) chooserOpened(tabId, null, true);
          return;
        }
        if (plan.route === "scripted") {
          const outcome = await scriptedClick(tabId, resolved, button);
          point = outcome.point;
          clickedTag = outcome.tag;
          if (outcome.fileInput) {
            // Record the chooser a real click would have opened, so the caller is
            // told to answer it with `page.upload` and `health.dialogs` shows why
            // the tab is waiting.
            chooserOpened(tabId, resolved.backendNodeId ?? null, true);
          }
          return;
        }
        await mouseClick(tabId, point, button);
      },
    );
  } catch (error) {
    const isTimeout =
      error instanceof Error && "payload" in error && (error as { payload: { code: string } }).payload.code === "timeout";
    const dialogOpen = openDialog(tabId) !== null || recentDialog(tabId) !== null;
    if (!isTimeout || !dialogOpen) throw error;
    queuedBehindDialog = true;
  }
  // A dialog opened by this click arrives as a CDP event a moment later; wait for
  // it briefly so the caller learns about it in the reply that caused it.
  for (let attempt = 0; attempt < 10 && openDialog(tabId) === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  // A dialog opened by the click is reported now, not on the next command —
  // including one that opened and closed inside the settle window.
  const dialog = openDialog(tabId) ?? recentDialog(tabId, 2_000);
  return {
    tabId,
    clicked: point,
    ...(clickedTag === null ? {} : { clickedTag }),
    button,
    input: { route: plan.route, reason: plan.reason },
    ...(resolved.frameUrl === undefined ? {} : { frame: resolved.frameUrl }),
    documentEpoch: documentEpochFor(tabId),
    queuedBehindDialog,
    needsHuman:
      dialog !== null
        ? { reason: "javascript_dialog", type: dialog.type, message: dialog.message }
        : openChooser(tabId) !== null
          ? { reason: "file_picker", message: "a file chooser is open; answer it with page.upload" }
          : null,
  } as unknown as JsonObject;
}

const KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

function modifiersMask(modifiers: readonly string[]): number {
  let mask = 0;
  if (modifiers.includes("alt")) mask |= 1;
  if (modifiers.includes("ctrl")) mask |= 2;
  if (modifiers.includes("meta")) mask |= 4;
  if (modifiers.includes("shift")) mask |= 8;
  return mask;
}

async function pressKey(tabId: number, keyName: string, modifiers: readonly string[]): Promise<void> {
  const named = KEYS[keyName] ?? (/^.$/u.test(keyName) ? { key: keyName, code: `Key${keyName.toUpperCase()}`, windowsVirtualKeyCode: keyName.toUpperCase().charCodeAt(0), text: keyName } : null);
  if (named === null) {
    throw commandError("invalid_request", `unknown key: ${keyName}`, false, { key: keyName, known: Object.keys(KEYS) });
  }
  const base = {
    key: named.key,
    code: named.code,
    windowsVirtualKeyCode: named.windowsVirtualKeyCode,
    nativeVirtualKeyCode: named.windowsVirtualKeyCode,
    modifiers: modifiersMask(modifiers),
  };
  await send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (named.text !== undefined) await send(tabId, "Input.dispatchKeyEvent", { type: "char", ...base, text: named.text });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/**
 * Type into a field. The field is focused by a real click first (a `focus()` call
 * is not enough for a framework that tracks pointer state), the existing value is
 * cleared when asked, and the text is inserted as one `Input.insertText` — which
 * is what a paste looks like to the page, and is far faster than per-character
 * key events for a long code.
 */
export async function typeCommand(params: TypeParams): Promise<JsonObject> {
  const { tabId, target, text, clear, pressEnter, inputRoute } = params;
  assertNoDialog(tabId);
  clearSyntheticChooser(tabId);
  await ensureSession(tabId);
  const resolved = await resolveTarget(tabId, target);
  const inFrame = resolved.frameId !== undefined;
  const plan = inFrame ? { route: "frame" as const, reason: `field is in frame ${resolved.frameUrl ?? ""}` } : await chooseInputPlan(tabId, inputRoute);
  if (resolved.frameId !== undefined) {
    // Focus inside the frame (selecting the old value when clearing), then insert
    // the text through the normal path: the focused element is in that frame, so
    // the browser routes the insertion there.
    const focused = await focusInFrame(tabId, resolved.frameId, resolved.frameSelector!, clear);
    if (focused.ok !== true) {
      throw commandError("not_found", focused.reason ?? "the field could not be focused in its frame", false, {
        tabId,
        frame: resolved.frameUrl ?? null,
      });
    }
  } else {
    await dispatchInput(tabId, () =>
      withChooserInterception(
        tabId,
        () => openRealChooser(tabId) !== null,
        async () => {
          if (plan.route === "scripted") {
            // The scripted click focuses the field as part of the sequence.
            await scriptedClick(tabId, resolved, "left");
            return;
          }
          await mouseClick(tabId, pointOf(resolved.box), "left");
        },
      ),
    );
  }

  if (clear && resolved.frameId === undefined) {
    // Select-all then delete, as a human would; clearing via the DOM would not
    // fire the events a controlled input needs. In a frame the field was already
    // selected by focusInFrame, and the insertion replaces the selection.
    // Select-all through an editing command rather than a bare Cmd/Ctrl+A
    // keydown: Chrome only maps the shortcut to the command when the event says
    // so, and without the selection Backspace deletes one character and the new
    // text lands in the middle of the old (measured in a test).
    const selectAllModifier = /Mac/i.test(navigator.userAgent) ? 4 : 2;
    const selectAll = {
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: selectAllModifier,
    };
    await send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...selectAll, commands: ["selectAll"] });
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...selectAll });
    await pressKey(tabId, "Backspace", []);
  }
  if (text.length > 0) {
    await send(tabId, "Input.insertText", { text });
  }
  if (pressEnter) await pressKey(tabId, "Enter", []);

  return {
    tabId,
    typed: text.length,
    cleared: clear,
    input: { route: plan.route, reason: plan.reason },
    ...(resolved.frameUrl === undefined ? {} : { frame: resolved.frameUrl }),
    documentEpoch: documentEpochFor(tabId),
  } as unknown as JsonObject;
}

export async function keyCommand(params: KeyParams): Promise<JsonObject> {
  const { tabId, key, modifiers } = params;
  assertNoDialog(tabId);
  await ensureSession(tabId);
  await dispatchInput(tabId, () => pressKey(tabId, key, modifiers));
  return { tabId, key, modifiers } as unknown as JsonObject;
}

/**
 * Scroll, inside the page.
 *
 * A wheel event through CDP is a compositor input and therefore dies on a
 * background tab, exactly like a click. Scrolling the container from inside the
 * page needs no compositor at all: the renderer's JS thread does the work and
 * answers. With a target the node's nearest scrollable ancestor moves; with a
 * point the element under it decides; with neither, the document (or the page's
 * own scroller) moves.
 */
export async function scrollCommand(params: ScrollParams): Promise<JsonObject> {
  const { tabId, target, deltaX, deltaY } = params;
  assertNoDialog(tabId);
  await ensureSession(tabId);

  let raw: unknown;
  if (target === undefined) {
    raw = (
      await send<{ result?: { value?: unknown } }>(
        tabId,
        "Runtime.evaluate",
        { expression: `(${SCROLL_FN}).call(document.scrollingElement || document.documentElement, ${deltaX}, ${deltaY})`, returnByValue: true },
        5_000,
      )
    ).result?.value;
  } else if (target.x !== undefined && target.y !== undefined) {
    raw = (
      await send<{ result?: { value?: unknown } }>(
        tabId,
        "Runtime.evaluate",
        {
          expression: `(${SCROLL_FN}).call(document.elementFromPoint(${target.x}, ${target.y}), ${deltaX}, ${deltaY})`,
          returnByValue: true,
        },
        5_000,
      )
    ).result?.value;
  } else {
    const resolved = await resolveTarget(tabId, target, { requireBox: false });
    if (resolved.frameId !== undefined) {
      // The scroller is inside a frame: scroll it there, where the DOM is. Same
      // reply shape as the top-document route, and a failure is an error rather
      // than an `ok` carrying `{ ok: false }`.
      const outcome = await scrollInFrame(tabId, resolved.frameId, resolved.frameSelector!, deltaX, deltaY);
      if (outcome.ok !== true) {
        throw commandError("not_found", outcome.reason ?? "the frame could not be scrolled", false, {
          tabId,
          frame: resolved.frameUrl ?? null,
        });
      }
      return {
        tabId,
        scrolled: {
          container: outcome.container ?? "document",
          deltaX,
          deltaY,
          moved: outcome.moved === true,
          before: outcome.before ?? { top: 0, left: 0 },
          after: outcome.after ?? { top: 0, left: 0 },
          maxScrollTop: outcome.maxScrollTop ?? 0,
          atLimit: outcome.atLimit === true,
        },
        input: { route: "page", reason: `scrolled inside frame ${resolved.frameUrl ?? ""}` },
        frame: resolved.frameUrl ?? null,
        documentEpoch: documentEpochFor(tabId),
      } as unknown as JsonObject;
    }
    if (resolved.objectId === undefined) {
      throw commandError("not_found", "scroll target could not be resolved to an element", false, { tabId });
    }
    raw = (
      await send<{ result?: { value?: unknown } }>(tabId, "Runtime.callFunctionOn", {
        objectId: resolved.objectId,
        functionDeclaration: SCROLL_FN,
        arguments: [{ value: deltaX }, { value: deltaY }],
        returnByValue: true,
      })
    ).result?.value;
  }

  const record = (raw ?? {}) as {
    ok?: boolean;
    reason?: string;
    container?: string;
    before?: { top: number; left: number };
    after?: { top: number; left: number };
    moved?: boolean;
    maxScrollTop?: number;
    atLimit?: boolean;
  };
  if (record.ok !== true) {
    throw commandError("not_found", `cannot scroll on tab ${tabId}: ${record.reason ?? "no scrollable container"}`, false, {
      tabId,
    });
  }
  return {
    tabId,
    scrolled: {
      container: record.container ?? "document",
      deltaX,
      deltaY,
      moved: record.moved === true,
      before: record.before ?? { top: 0, left: 0 },
      after: record.after ?? { top: 0, left: 0 },
      maxScrollTop: record.maxScrollTop ?? 0,
      // At the end of the range the scroll is a legitimate no-op, not a failure.
      atLimit: record.atLimit === true,
    },
    input: { route: "page", reason: "scrolled in the page; no compositor input is involved" },
    documentEpoch: documentEpochFor(tabId),
  } as unknown as JsonObject;
}

/**
 * Set a `<select>` the way a user's choice would: value plus the change events.
 *
 * `requireUnique` is on: a selector matching several controls is refused with the
 * candidates described, rather than silently taking whichever Chrome lists first
 * (a bare "select" once hit the theme picker instead of the contact picker).
 */
export async function selectCommand(params: SelectParams): Promise<JsonObject> {
  const { tabId, target, value } = params;
  assertNoDialog(tabId);
  const resolved = await resolveTarget(tabId, target, { requireUnique: true });
  if (resolved.objectId === undefined) {
    throw commandError("not_found", "target could not be resolved to an element", false, { tabId });
  }
  // The value goes in as a JSON literal rather than a CDP argument: one encoding
  // is one place for it to go wrong, and a literal cannot arrive as undefined.
  const applied = await send<{ result?: { value?: unknown } }>(tabId, "Runtime.callFunctionOn", {
    objectId: resolved.objectId,
    functionDeclaration: `function () {
      const wanted = ${JSON.stringify(value)};
      if (!(this instanceof HTMLSelectElement)) return { ok: false, reason: "not a select element" };
      // Identify the control this resolved to. A bare selector like "select"
      // matches the FIRST select on the page, which may be an unrelated control
      // near the top; without the identity, a wrong match is only inferable from
      // the option list. Reporting it makes the mistake visible in the result.
      const self = {
        tag: this.tagName.toLowerCase(),
        id: this.id || null,
        name: this.getAttribute("name") || null,
        ariaLabel: this.getAttribute("aria-label") || null,
        options: this.options.length,
      };
      const match = Array.from(this.options).find((option) => option.value === wanted || option.text === wanted);
      if (!match) return { ok: false, reason: "no option matches", options: Array.from(this.options).map((o) => o.value), matched: self };
      // A user cannot pick a disabled option, so neither can this. "Disabled" usually
      // means out of stock or not permitted; selecting it anyway would record the
      // forbidden value as a deliberate choice (docs/protocol.md: "the way a user's
      // choice does"). A disabled <select> is the same answer for the same reason.
      if (this.disabled || match.disabled || (match.parentElement instanceof HTMLOptGroupElement && match.parentElement.disabled)) {
        return { ok: false, reason: "option is disabled", matched: self };
      }
      this.value = match.value;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: this.value, matched: self };
    }`,
    returnByValue: true,
  });
  const outcome = applied.result as { value?: unknown } | undefined;
  const record = (outcome?.value ?? {}) as {
    ok?: boolean;
    reason?: string;
    options?: string[];
    value?: string;
    matched?: Record<string, unknown>;
  };
  if (record.ok !== true) {
    throw commandError("invalid_request", `cannot select "${value}": ${record.reason ?? "unknown"}`, false, {
      tabId,
      options: record.options ?? [],
      matched: (record.matched ?? null) as unknown as JsonValue,
    });
  }
  return {
    tabId,
    value: record.value ?? value,
    // What the selector actually resolved to, so a wrong first match is visible.
    matched: (record.matched ?? null) as unknown as JsonValue,
    documentEpoch: documentEpochFor(tabId),
  } as unknown as JsonObject;
}

/** Attach files to a file input, the way a file picker would. */
export async function uploadCommand(params: UploadParams): Promise<JsonObject> {
  const { tabId, target, files } = params;
  assertNoDialog(tabId);
  await ensureSession(tabId);
  // A file input is usually behind a styled label and has no box at all, so
  // geometry must not be required here.
  const resolved = await resolveTarget(tabId, target, { requireBox: false });
  if (resolved.backendNodeId === undefined) {
    throw commandError("not_found", "target could not be resolved to a node", false, { tabId });
  }
  // docs/protocol.md: "attaches absolute file paths". A relative path would resolve
  // against Chrome's own working directory, not the caller's intent, so refuse it
  // rather than attach a file the caller did not name.
  const notAbsolute = files.filter((file) => !file.startsWith("/"));
  if (notAbsolute.length > 0) {
    throw commandError("invalid_request", `cannot attach files: not an absolute path`, false, {
      tabId,
      files: notAbsolute,
    });
  }
  try {
    await send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: resolved.backendNodeId });
    // Only the chooser this upload answered is settled: a different pending input
    // is still waiting for its own files.
    const pending = openChooser(tabId);
    if (pending === null || pending.backendNodeId === null || pending.backendNodeId === resolved.backendNodeId) {
      chooserResolved(tabId);
    }
  } catch (error) {
    throw commandError("invalid_request", `cannot attach files: ${(error as Error).message}`, false, { tabId, files });
  }
  // `count: files.length` reports what the caller asked for, not what the input
  // now holds: Chrome manufactures a zero-byte File for a path that does not
  // exist and reports no error, so the page silently receives a ghost. Read the
  // node's files back and report that instead — docs/protocol.md promises a real
  // file-picker result, and a caller cannot otherwise tell an attach from an
  // invention.
  const attached = await readAttachedFiles(tabId, resolved.objectId);
  // A path Chrome could not read becomes a zero-byte File, so `count` alone cannot
  // tell a real attach from an invented one. Report both: the count of files the
  // input now holds, and each one's name and size. A caller that asked for a file
  // and got `size: 0` back can see it was not really attached.
  const empty = attached.filter((entry) => entry.size === 0).map((entry) => entry.name);
  return { tabId, files, count: attached.length, attached, ...(empty.length > 0 ? { empty } : {}) } as unknown as JsonObject;
}

/** What a file input actually holds after the attach, as name/size pairs. */
async function readAttachedFiles(
  tabId: number,
  objectId: string | undefined,
): Promise<Array<{ name: string; size: number }>> {
  if (objectId === undefined) return [];
  try {
    const read = await send<{ result?: { value?: unknown } }>(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        if (!(this instanceof HTMLInputElement) || this.type !== "file") return [];
        return Array.from(this.files || []).map((f) => ({ name: f.name, size: f.size }));
      }`,
      returnByValue: true,
    });
    const value = read.result?.value;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is { name: string; size: number } =>
        typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string",
    );
  } catch {
    // The attach itself succeeded; only the readback failed. Reporting zero would
    // wrongly imply nothing landed, so fall back to the requested list.
    return [];
  }
}

/**
 * Click something that starts a download and report what Chrome did with it.
 *
 * The download goes to the profile's normal download folder: the extension does
 * not choose a directory, because a path chosen by the agent would be a surprise
 * and `chrome.downloads` already has a good default.
 */
export async function downloadCommand(params: DownloadParams): Promise<JsonObject> {
  const { tabId, target, timeoutMs } = params;
  assertNoDialog(tabId);
  const resolved = await resolveTarget(tabId, target);
  // The click that starts a download is the same input problem as any other click.
  const plan = await chooseInputPlan(tabId, "auto");

  interface DownloadReport {
    id: number;
    state: string;
    filename: string;
    finalUrl: string;
    mime: string;
  }

  const startedAt = new Date().toISOString();
  let listener: ((item: chrome.downloads.DownloadItem) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arrived = new Promise<DownloadReport>((resolve) => {
    listener = (item: chrome.downloads.DownloadItem) => {
      // A download this click did not start is not the answer to this command.
      if (item.startTime !== undefined && item.startTime < startedAt) return;
      chrome.downloads.onCreated.removeListener(listener!);
      // `onCreated` fires before Chrome has resolved a target path, so `filename`
      // is often empty at this point. Poll briefly, and report `finalUrl` either
      // way: it is what identifies the download when the path is not yet known.
      void (async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const [current] = await chrome.downloads.search({ id: item.id });
          if (current !== undefined && current.filename !== "") {
            resolve({
              id: current.id,
              state: current.state,
              filename: current.filename,
              finalUrl: current.finalUrl || current.url,
              mime: current.mime,
            });
            return;
          }
          await new Promise((next) => setTimeout(next, 50));
        }
        resolve({
          id: item.id,
          state: item.state,
          filename: item.filename,
          finalUrl: item.finalUrl || item.url,
          mime: item.mime,
        });
      })();
    };
    chrome.downloads.onCreated.addListener(listener);
  });

  try {
    if (resolved.frameId !== undefined) {
      // A frame target has no box in the tab and no objectId: it is clicked inside
      // its own frame, like every other framed action.
      const outcome = await clickInFrame(tabId, resolved.frameId, resolved.frameSelector!, "left");
      if (outcome.ok !== true) {
        throw commandError("not_found", outcome.reason ?? "the download link could not be clicked in its frame", false, {
          tabId,
          frame: resolved.frameUrl ?? null,
        });
      }
      if (outcome.fileInput === true) chooserOpened(tabId, null, true);
    } else if (plan.route === "scripted") await scriptedClick(tabId, resolved, "left");
    else await mouseClick(tabId, pointOf(resolved.box), "left");
  } catch (error) {
    if (listener !== null) chrome.downloads.onCreated.removeListener(listener);
    throw error;
  }

  const timeout = new Promise<never>((resolve, reject) => {
    void resolve;
    timer = setTimeout(
      () =>
        reject(
          // Not retryable: the click may have started a download that is simply
          // slower than the timeout, and clicking twice would download twice.
          commandError("timeout", `no download started within ${timeoutMs} ms`, false, {
            tabId,
            hint: "The click may not have started a download, or Chrome asked a question first",
          }),
        ),
      timeoutMs,
    );
  });

  try {
    const item = await Promise.race([arrived, timeout]);
    return { tabId, download: item } as unknown as JsonObject;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Wait for a condition on the tab. Polled, never assumed: a page that never
 * satisfies it gets `timeout` with what was last seen.
 */
export async function waitForCommand(params: WaitForParams): Promise<JsonObject> {
  const { tabId, selector, text, urlIncludes, timeoutMs } = params;
  assertNoDialog(tabId);
  const deadline = Date.now() + timeoutMs;
  let last: { url: string | null; found: boolean; textFound: boolean } = { url: null, found: false, textFound: false };

  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab === null) throw commandError("not_found", `tab ${tabId} no longer exists`, false, { tabId });
    last = { url: tab.url ?? null, found: false, textFound: false };

    let selectorOk = selector === undefined;
    let textOk = text === undefined;
    if (!selectorOk || !textOk) {
      // A renderer that is busy (or blocked by a dialog) must not hold the loop
      // past its own deadline: each probe gets a fraction of the remaining time.
      const probe = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          func: (wantedSelector: string | null, wantedText: string | null) => {
            let selector: boolean | "invalid" = true;
            if (wantedSelector !== null) {
              // An invalid selector throws here rather than answering false. Swallowing
              // that into the wait loop reports "never matched" for a selector that
              // could never match, so a caller branching on `code` cannot tell a
              // typo from a slow page.
              try {
                selector = document.querySelector(wantedSelector) !== null;
              } catch {
                selector = "invalid";
              }
            }
            return {
              selector,
              text:
                wantedText === null
                  ? true
                  : (document.body?.innerText ?? "").toLowerCase().includes(wantedText.toLowerCase()),
            };
          },
          args: [selector ?? null, text ?? null],
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(250, Math.min(2_000, deadline - Date.now())))),
      ]);
      if (probe === null) {
        assertNoDialog(tabId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const value = probe[0]?.result as { selector?: boolean | "invalid"; text?: boolean } | undefined;
      if (value?.selector === "invalid") {
        throw commandError("invalid_request", `selector is not valid CSS: ${selector}`, false, {
          tabId,
          selector: selector ?? null,
        });
      }
      selectorOk = value?.selector === true;
      // Portals put the thing being waited for inside an iframe; a top-document
      // probe would time out on a condition that is already true.
      if (!selectorOk && selector !== undefined) selectorOk = await selectorInAnyFrame(tabId, selector);
      textOk = value?.text === true;
    }
    last.found = selectorOk;
    last.textFound = textOk;
    const urlOk = urlIncludes === undefined ? true : (last.url ?? "").includes(urlIncludes);

    if (selectorOk && textOk && urlOk) {
      return { tabId, matched: { selector, text, urlIncludes }, url: last.url, waitedMs: timeoutMs - (deadline - Date.now()) } as unknown as JsonObject;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw commandError("timeout", `condition not met within ${timeoutMs} ms`, true, {
    tabId,
    lastSeen: last,
    conditions: { selector: selector ?? null, text: text ?? null, urlIncludes: urlIncludes ?? null },
  });
}

/**
 * `page.evaluate`, behind the human-owned switch (plan §5.1). The agent may read
 * the setting and may never flip it; when it is off this answers
 * `evaluate_disabled` with a hint a human can act on.
 */
export async function evaluateCommand(params: EvaluateParams, enabled: boolean): Promise<JsonObject> {
  if (!enabled) {
    throw commandError("evaluate_disabled", "Enable 'Allow page.evaluate' in the Ava extension settings", false, {
      tabId: params.tabId,
    });
  }
  const { tabId, expression, awaitPromise } = params;
  const result = await send<{ result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string } }>(
    tabId,
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true, timeout: WAIT_TIMEOUT_DEFAULT },
  );
  if (result.exceptionDetails !== undefined) {
    const details = result.exceptionDetails as { text?: string; exception?: { description?: string } };
    throw commandError("internal", `evaluate threw: ${details.exception?.description ?? details.text ?? "unknown"}`, false, {
      tabId,
    });
  }
  const raw = result.result?.value ?? result.result?.description ?? null;
  // Plan §5.1: an evaluate result is bounded, and a cut says so.
  const bounded =
    typeof raw === "string"
      ? clampText(raw, 4_000)
      : raw !== null && typeof raw === "object"
        ? clampText(JSON.stringify(raw), 4_000)
        : { text: raw as unknown, truncated: false };
  return {
    tabId,
    value: bounded.text as never,
    truncated: bounded.truncated,
    documentEpoch: documentEpochFor(tabId),
  } as unknown as JsonObject;
}

export const ACTION_DEFAULTS = { waitTimeoutMs: WAIT_TIMEOUT_DEFAULT };

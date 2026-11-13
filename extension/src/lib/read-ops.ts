/**
 * M2: reading a tab that is not in front.
 *
 * Three reads, each with the source it can actually use:
 *   - `readAX`  — accessibility tree through CDP, with a DOM fallback that
 *                 reports the degraded source rather than pretending;
 *   - `getText` — rendered text through `chrome.scripting` (no infobar, cheap);
 *   - `screenshot` — PNG through CDP, of the tab, plus a staleness check.
 *
 * The screenshot question is the honest one: Chrome composites a background tab
 * lazily, so a capture can return the previous frame. Rather than claiming
 * freshness, a capture that asked for `detectStale` compares against the previous
 * capture of the same tab taken before a DOM mutation; identical bytes are
 * reported as `possiblyStale: true` and the docs tell the caller to prefer
 * `readAX` when it matters.
 */

import {
  AX_NODE_LIMIT_DEFAULT,
  MAX_SCREENSHOT_BASE64,
  type AxNode,
  type AxReadResult,
  type JsonObject,
  type ReadParams,
  type ScreenshotParams,
  type ScreenshotResult,
  type TextParams,
  type TextResult,
} from "@gb-ava/protocol";
import { clampText, shapeAxTree, type RawAxNode } from "./ax.js";
import { commandError } from "./errors.js";
import { requireTabs } from "./tab-ops.js";
import { send } from "./debugger.js";
import { readFrames } from "./frames.js";

/** Last capture per tab, for the staleness comparison. Bounded and never persisted. */
const lastCapture = new Map<number, string>();

/**
 * A node id or a capture is only meaningful for the document that produced it.
 * The epoch moves when the tab navigates (the worker bumps it from
 * chrome.tabs.onUpdated), so a caller holding a node id can tell it is stale.
 */
const documentEpochs = new Map<number, number>();

export function documentEpochFor(tabId: number): number {
  return documentEpochs.get(tabId) ?? 0;
}

export function bumpDocumentEpoch(tabId: number): void {
  documentEpochs.set(tabId, documentEpochFor(tabId) + 1);
  lastCapture.delete(tabId);
}

interface TabIdentity {
  url: string | null;
  title: string | null;
}

/**
 * The tab's identity, sampled *after* the read: a page that navigated mid-read
 * must not be reported with the URL it used to have.
 */
async function identity(tabId: number): Promise<TabIdentity> {
  const [tab] = await requireTabs([tabId]);
  return { url: tab?.url ?? null, title: tab?.title ?? null };
}

/**
 * The DOM fallback for the accessibility tree: roles that the DOM can prove,
 * without geometry. Used when the debugger cannot attach (DevTools open), so a
 * read still answers — with `source: "scripting"` and no bounds.
 */
async function readAxViaScripting(tabId: number, limit: number): Promise<RawAxNode[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (nodeLimit: number) => {
      const ROLE_BY_TAG: Record<string, string> = {
        a: "link",
        button: "button",
        input: "textbox",
        textarea: "textbox",
        select: "combobox",
        h1: "heading",
        h2: "heading",
        h3: "heading",
        img: "image",
        ul: "list",
        ol: "list",
        li: "listitem",
      };
      const root = document.body ?? document.documentElement;
      const nodes: Array<Record<string, unknown>> = [];
      const indexOf = new Map<Element, number>();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let current: Element | null = root;
      while (current !== null && nodes.length < nodeLimit) {
        const index = nodes.length;
        const tag = current.tagName.toLowerCase();
        const role = current.getAttribute("role") ?? ROLE_BY_TAG[tag] ?? tag;
        const name =
          current.getAttribute("aria-label") ??
          current.getAttribute("alt") ??
          (current as HTMLElement).innerText?.trim().slice(0, 120) ??
          "";
        const parent = current.parentElement;
        const parentIndex = parent === null ? undefined : indexOf.get(parent);
        nodes.push({
          nodeId: `dom-${index}`,
          role: { value: role },
          name: { value: name },
          childIds: [],
        });
        if (parentIndex !== undefined) {
          (nodes[parentIndex]!["childIds"] as string[]).push(`dom-${index}`);
        }
        indexOf.set(current, index);
        current = walker.nextNode() as Element | null;
      }
      // A flat list with no edges would be a tree of one node; the shaper needs
      // the parent links to see anything beyond the root.
      return nodes;
    },
    args: [Math.min(limit, 1000)],
  });
  const first = results[0]?.result;
  return Array.isArray(first) ? (first as RawAxNode[]) : [];
}

export async function readAxCommand(params: ReadParams): Promise<JsonObject> {
  const { tabId, limit, includeInvisible } = params;
  const { url, title } = await identity(tabId);

  let nodes: RawAxNode[];
  let source: "debugger" | "scripting" = "debugger";
  try {
    const tree = await send<{ nodes?: RawAxNode[] }>(tabId, "Accessibility.getFullAXTree", {});
    nodes = tree.nodes ?? [];
  } catch (error) {
    if (!(error instanceof Error) || !("payload" in error)) throw error;
    const payload = (error as { payload: { code: string } }).payload;
    if (payload.code !== "debugger_unavailable") throw error;
    // A read must still answer when DevTools owns the tab: say so in `source`.
    source = "scripting";
    nodes = await readAxViaScripting(tabId, limit);
  }

  const shaped = shapeAxTree(nodes, { limit, includeInvisible });

  // A CDP session does not cross an out-of-process iframe, and every Microsoft
  // admin portal puts its content in one: without this the read answered the shell
  // and looked complete. Framed nodes are read from inside their own frame and are
  // addressed by `selector`, never by a `nodeId` from another session.
  const framed = await framedAxNodes(tabId, Math.max(0, limit - shaped.nodes.length));
  const merged = shaped.nodes.concat(framed.nodes);
  const after = await identity(tabId);
  const result: AxReadResult = {
    tabId,
    url: after.url ?? url,
    title: after.title ?? title,
    documentEpoch: documentEpochFor(tabId),
    nodes: merged,
    totalNodes: shaped.totalNodes + framed.totalNodes,
    truncated: shaped.truncated || framed.truncated,
    source,
    frames: framed.frames,
    framesNotRead: framed.notRead,
  };
  return result as unknown as JsonObject;
}

/**
 * Nodes from every child frame, as `AxNode`s with a `selector` and no `nodeId`.
 *
 * Deliberately honest about fidelity: this is a DOM walk inside the frame, not a
 * Chrome accessibility tree, so the reply's `frames[].source` says `scripting` and
 * the caller knows what it is reading. Skipped entirely (one cheap injection to
 * find out) when the page has no child frames at all.
 */
async function framedAxNodes(
  tabId: number,
  budget: number,
): Promise<{
  nodes: AxNode[];
  totalNodes: number;
  frames: NonNullable<AxReadResult["frames"]>;
  notRead: NonNullable<AxReadResult["framesNotRead"]>;
  truncated: boolean;
}> {
  const empty = { nodes: [] as AxNode[], totalNodes: 0, frames: [], notRead: [], truncated: false };
  if (!(await hasChildFrames(tabId))) return empty;

  // Read a full page per frame even when the budget is small, so the count that is
  // reported is real: a cap that silently cut a frame is the "looks complete, is
  // not" failure this read is supposed to have fixed, one level down.
  const read = await readFrames(tabId, { nodeLimit: 2_000, textLimit: 1 });
  const nodes: AxNode[] = [];
  const frames: NonNullable<AxReadResult["frames"]> = [];
  let total = 0;
  let truncated = false;
  for (const frame of read.frames) {
    // The tab's own document is already covered by the CDP tree above.
    if (frame.frameId === 0) continue;
    if (budget === 0) {
      truncated = true;
      frames.push({ index: frames.length, url: frame.url, title: frame.title, nodes: 0, source: "scripting" });
      total += frame.nodes.length;
      continue;
    }
    if (frame.truncated) truncated = true;
    let included = 0;
    for (const node of frame.nodes) {
      if (nodes.length >= budget) break;
      included += 1;
      nodes.push({
        nodeId: null,
        role: node.role,
        name: node.name,
        value: node.value,
        description: null,
        // The index in this reply's `frames` array, assigned after the top frame
        // is filtered out — `frame` is a pointer into this reply, not into the
        // frame list the walker produced.
        frame: frames.length,
        selector: node.selector,
        visible: true,
        disabled: node.disabled,
        focused: false,
        checked: node.checked,
        // Relative to the frame's own viewport, not the tab's.
        bounds: node.bounds,
        childCount: 0,
      });
    }
    if (nodes.length >= budget && included < frame.nodes.length) truncated = true;
    // The frame is registered after its nodes, so `frames.length` above is this
    // frame's index in the reply.
    frames.push({ index: frames.length, url: frame.url, title: frame.title, nodes: included, source: "scripting" });
    total += frame.nodes.length;
  }
  return { nodes, totalNodes: total, frames, notRead: read.notRead, truncated: truncated || read.frames.length < read.expected };
}

/** One cheap injection: does this page have any child frame at all? */
async function hasChildFrames(tabId: number): Promise<boolean> {
  try {
    const [main] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.frames.length,
    });
    return (main?.result ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function getTextCommand(params: TextParams): Promise<JsonObject> {
  const { tabId, limit } = params;
  const { url, title } = await identity(tabId);

  // Text is gathered frame by frame: a portal's content is in an iframe, and a
  // top-document-only read answered "Microsoft Entra is loading." for a page that
  // was fully rendered. Each frame's text is taken generously and the *merged*
  // text is clamped once, so `truncated` reflects the caller's limit rather than
  // the per-frame cap.
  const frames = await readFrames(tabId, { nodeLimit: 200, textLimit: Math.min(200_000, Math.max(limit, 20_000)) });
  const sections: string[] = [];
  const summary: NonNullable<TextResult["frames"]> = [];
  for (const frame of frames.frames) {
    const isTop = frame.frameId === 0;
    summary.push({ index: frame.index, url: frame.url, title: frame.title, characters: frame.text.length });
    if (isTop) {
      sections.push(frame.text);
      continue;
    }
    sections.push(`[frame ${frame.index}: ${frame.url}]\n${frame.text.length > 0 ? frame.text : "(no text)"}`);
  }
  const combined = sections.filter((section) => section.length > 0).join("\n\n");

  const clamped = clampText(combined, limit);
  // A frame whose own text hit its cap was cut before the merge, so the merged
  // `length` is not the page's real length: say truncated rather than under-report.
  const cutInsideAFrame = frames.frames.some((frame) => frame.textTruncated);
  const after = await identity(tabId);
  const result: TextResult = {
    tabId,
    url: after.url ?? url,
    title: after.title ?? title,
    documentEpoch: documentEpochFor(tabId),
    text: clamped.text,
    length: combined.length,
    truncated: clamped.truncated || cutInsideAFrame,
    source: "scripting",
    frames: summary,
    framesNotRead: frames.notRead,
  };
  return result as unknown as JsonObject;
}

export async function screenshotCommand(params: ScreenshotParams): Promise<JsonObject> {
  const { tabId, detectStale } = params;
  const { url } = await identity(tabId);

  const capture = await send<{ data?: string }>(tabId, "Page.captureScreenshot", {
    format: "png",
    // `fromSurface` captures what the compositor has, including a background tab.
    fromSurface: true,
    captureBeyondViewport: false,
  });

  const png = typeof capture.data === "string" ? capture.data : "";
  if (png.length === 0) {
    throw commandError("internal", `tab ${tabId} returned an empty screenshot`, false, { tabId });
  }
  if (png.length > MAX_SCREENSHOT_BASE64) {
    throw commandError("internal", `screenshot of tab ${tabId} is too large (${png.length} base64 characters)`, false, {
      tabId,
    });
  }

  const previous = lastCapture.get(tabId);
  lastCapture.set(tabId, png);

  // Dimensions come from the PNG header rather than another round trip.
  const header = decodePngSize(png);
  const after = await identity(tabId);
  const result: ScreenshotResult = {
    tabId,
    url: after.url ?? url,
    documentEpoch: documentEpochFor(tabId),
    png,
    bytes: Math.floor((png.length * 3) / 4),
    width: header?.width ?? null,
    height: header?.height ?? null,
    possiblyStale: detectStale && previous !== undefined && previous === png,
    source: "debugger",
  };
  return result as unknown as JsonObject;
}

/** Width and height from the IHDR chunk of a base64 PNG, or null if it is not one. */
export function decodePngSize(base64: string): { width: number; height: number } | null {
  try {
    const binary = atob(base64.slice(0, 64));
    if (binary.length < 24) return null;
    const signature = [0x89, 0x50, 0x4e, 0x47];
    for (let index = 0; index < signature.length; index += 1) {
      if (binary.charCodeAt(index) !== signature[index]) return null;
    }
    const width =
      (binary.charCodeAt(16) << 24) | (binary.charCodeAt(17) << 16) | (binary.charCodeAt(18) << 8) | binary.charCodeAt(19);
    const height =
      (binary.charCodeAt(20) << 24) | (binary.charCodeAt(21) << 16) | (binary.charCodeAt(22) << 8) | binary.charCodeAt(23);
    return { width: width >>> 0, height: height >>> 0 };
  } catch {
    return null;
  }
}

/** Forget the staleness baseline for a tab that navigated or closed. */
export function forgetCapture(tabId: number): void {
  lastCapture.delete(tabId);
}

export const READ_DEFAULTS = { nodeLimit: AX_NODE_LIMIT_DEFAULT };

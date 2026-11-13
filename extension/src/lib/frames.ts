/**
 * Frames.
 *
 * Admin portals — Microsoft Entra and the M365 admin center are the ones this was
 * built for — render their real content inside an iframe. A CDP session attached
 * to the tab does not cross an out-of-process (cross-origin) frame, so
 * `page.readAX` returned the portal shell and `page.getText` returned a page that
 * looked empty, both with no error. The answer was only reachable by screenshot.
 *
 * The route that does cross every frame is `chrome.scripting.executeScript` with
 * `allFrames: true`: the extension holds `<all_urls>` and injects into each frame
 * separately, regardless of the page's own origin rules. So frame content is read
 * and acted on from inside the frame that owns it:
 *
 *   - reads return each frame's text and a DOM-derived node list where every node
 *     carries a `selector` that is unique in its own frame;
 *   - an element in a child frame is addressed by that selector — the frame is
 *     resolved for the caller, so a `page.click` with a selector reaches into the
 *     frame without the caller having to know one exists;
 *   - anything that could not be read is named in `framesNotRead` with a reason,
 *     never dropped.
 *
 * What this deliberately does not do: pretend a scripted DOM walk is a real
 * accessibility tree. The main frame keeps its CDP tree; framed nodes say
 * `source: "scripting"` so a caller knows the fidelity it is getting.
 */

import { commandError } from "./errors.js";

/** A node read from a child frame. `selector` is unique within that frame. */
export interface FrameNode {
  role: string;
  name: string;
  /** Unique in its frame, or null when no unique path exists (deeply nested duplicates). */
  selector: string | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  disabled: boolean;
  /** Tri-state as in the tab's own AX tree: `null` for a role that cannot be checked. */
  checked: boolean | null;
  value: string | null;
}

export interface FrameRead {
  /** Index in the reply's `frames` array; what a node's `frame` field refers to. */
  index: number;
  frameId: number;
  url: string;
  title: string;
  nodes: FrameNode[];
  text: string;
  /** The frame had more nodes than the per-frame cap. */
  truncated: boolean;
  /** The frame's text was longer than the per-frame cap. */
  textTruncated: boolean;
}

export interface FramesRead {
  frames: FrameRead[];
  notRead: Array<{ url: string | null; reason: string }>;
  /** How many frames the page says it has (a lower bound on what should be readable). */
  expected: number;
}

/**
 * The walker injected into every frame. Must be self-contained: `executeScript`
 * serializes the function, so it cannot close over anything in this module.
 */
function walkFrame(nodeLimit: number, textLimit: number): {
  url: string;
  title: string;
  nodes: Array<{
    role: string;
    name: string;
    selector: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
    disabled: boolean;
    checked: boolean | null;
    value: string | null;
  }>;
  text: string;
  truncated: boolean;
  textTruncated: boolean;
  childFrames: number;
} {
  // Roles whose checked state matters, mirroring the tab's own AX tree. Defined
  // inside the injected function because this body is serialised and run in the frame.
  const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  const checkedOf = (role: string, element: Element): boolean | null => {
    if (!CHECKABLE_ROLES.has(role)) return null;
    if (element instanceof HTMLInputElement) {
      if (element.type === "radio" || element.type === "checkbox") return element.checked;
    }
    const aria = element.getAttribute("aria-checked");
    if (aria === "true") return true;
    if (aria === "false") return false;
    return null;
  };

  // A path is returned only when it addresses exactly this element. A non-unique
  // path is worse than none: `page.click` by that selector would click a different
  // element and answer ok. So the walk climbs until unique and gives up with null.
  const cssPath = (element: Element): string | null => {
    const steps: string[] = [];
    let node: Element | null = element;
    while (node !== null && node.nodeType === 1) {
      if (node.id !== "") {
        const byId = `#${CSS.escape(node.id)}`;
        if (document.querySelectorAll(byId).length === 1) return [byId, ...steps].join(" > ");
      }
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent !== null) {
        const same = Array.from(parent.children).filter((child) => child.tagName === node!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      steps.unshift(part);
      const candidate = steps.join(" > ");
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (error) {
        void error;
        return null;
      }
      node = parent;
    }
    return null;
  };

  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute("role");
    if (explicit !== null && explicit !== "") return explicit;
    const tag = element.tagName.toLowerCase();
    const byTag: Record<string, string> = {
      a: "link",
      button: "button",
      input: (element as HTMLInputElement).type === "checkbox" ? "checkbox" : "textbox",
      textarea: "textbox",
      select: "combobox",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
      img: "image",
      ul: "list",
      ol: "list",
      li: "listitem",
      table: "table",
      tr: "row",
      td: "cell",
      th: "columnheader",
      nav: "navigation",
      main: "main",
      header: "banner",
      footer: "contentinfo",
      form: "form",
      label: "label",
    };
    return byTag[tag] ?? tag;
  };

  const nameOf = (element: Element): string => {
    const direct =
      element.getAttribute("aria-label") ??
      element.getAttribute("alt") ??
      element.getAttribute("title") ??
      element.getAttribute("placeholder");
    if (direct !== null && direct.trim() !== "") return direct.trim().slice(0, 160);
    const inner = (element as HTMLElement).innerText ?? "";
    // Only a short own-text is a name; a container's whole subtree is not.
    const trimmed = inner.trim();
    if (trimmed !== "" && trimmed.length <= 160) return trimmed;
    return "";
  };

  const INTERACTIVE = new Set([
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "option",
    "summary",
    "label",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "img",
    "li",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "tab",
    "menuitem",
    "option",
    "checkbox",
    "radio",
    "switch",
    "textbox",
    "combobox",
    "searchbox",
    "row",
    "cell",
    "gridcell",
    "heading",
    "listitem",
    "treeitem",
  ]);

  const nodes: Array<{
    role: string;
    name: string;
    selector: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
    disabled: boolean;
    checked: boolean | null;
    value: string | null;
  }> = [];

  const root: Element | null = document.body ?? document.documentElement;
  const walker = root === null ? null : document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let current: Element | null = root;
  while (current !== null && nodes.length < nodeLimit) {
    const role = roleOf(current);
    const tag = current.tagName.toLowerCase();
    const isInteractive =
      INTERACTIVE.has(tag) || INTERACTIVE_ROLES.has(role) || current.hasAttribute("onclick") || current.hasAttribute("tabindex");
    const name = nameOf(current);
    if (isInteractive && (name !== "" || tag === "input" || tag === "select" || tag === "textarea")) {
      const rect = current.getBoundingClientRect();
      const value =
        tag === "input" || tag === "textarea" || tag === "select" ? ((current as HTMLInputElement).value ?? null) : null;
      nodes.push({
        role,
        name,
        selector: cssPath(current),
        bounds:
          rect.width === 0 && rect.height === 0
            ? null
            : { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        disabled: (current as HTMLButtonElement).disabled === true || current.getAttribute("aria-disabled") === "true",
        checked: checkedOf(role, current),
        value: value === null ? null : String(value).slice(0, 200),
      });
    }
    current = walker === null ? null : (walker.nextNode() as Element | null);
  }

  const bodyText = (document.body?.innerText ?? document.documentElement?.innerText ?? "").trim();
  return {
    url: location.href,
    title: document.title,
    nodes,
    text: bodyText.slice(0, textLimit),
    // Whether the cap was hit, and how full the frame's text was: a read that ends
    // at the cap without saying so is the same "looks complete, is not" failure
    // this module exists to fix.
    truncated: nodes.length >= nodeLimit && current !== null,
    textTruncated: bodyText.length > textLimit,
    childFrames: window.frames.length,
  };
}

/**
 * Read every frame the extension can inject into.
 *
 * The tab's own document is included as the first entry, marked so a caller can
 * tell the top frame from a child. Chrome reports the frames it could not reach
 * (sandboxed frames, the PDF viewer's internal frames, chrome:// content) through
 * `executeScript` results that carry an error, and those are returned as `notRead`
 * rather than omitted.
 */
export async function readFrames(tabId: number, options: { nodeLimit: number; textLimit: number }): Promise<FramesRead> {
  const perFrame = Math.max(50, Math.min(options.nodeLimit, 2_000));
  let results: chrome.scripting.InjectionResult<ReturnType<typeof walkFrame>>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: walkFrame,
      args: [perFrame, options.textLimit],
    });
  } catch (error) {
    throw commandError("internal", `cannot read frames on tab ${tabId}: ${(error as Error).message}`, false, { tabId });
  }

  const frames: FrameRead[] = [];
  const notRead: Array<{ url: string | null; reason: string }> = [];
  let expected = 0;
  results.forEach((entry, position) => {
    const value = entry.result;
    if (value === undefined || value === null) {
      notRead.push({ url: null, reason: `the extension could not read frame ${position}` });
      return;
    }
    // The top frame reports how many child frames the page has, which is the only
    // count available: Chrome returns no entry for a frame it refused to inject
    // into, so a short result list is otherwise invisible.
    expected = Math.max(expected, 1 + (value.childFrames ?? 0));
    frames.push({
      index: frames.length,
      frameId: entry.frameId,
      url: value.url,
      title: value.title,
      nodes: value.nodes,
      text: value.text,
      truncated: value.truncated === true,
      textTruncated: value.textTruncated === true,
    });
  });
  if (frames.length < expected) {
    notRead.push({
      url: null,
      reason: `${expected - frames.length} of ${expected} frames could not be read (sandboxed or not scriptable)`,
    });
  }
  return { frames, notRead, expected: Math.max(expected, frames.length) };
}

/**
 * Every frame that holds an element matching `selector`.
 *
 * More than one match is returned rather than collapsed to the first: a selector
 * that exists in two frames is ambiguous, and clicking the wrong frame's element
 * while answering `ok` is the failure mode this product cares about most.
 */
export async function findInFrames(
  tabId: number,
  selector: string,
): Promise<Array<{ frameId: number; url: string; count: number }>> {
  let results: chrome.scripting.InjectionResult<{ url: string; count: number }>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (wanted: string): { url: string; count: number } => {
        try {
          return { url: location.href, count: document.querySelectorAll(wanted).length };
        } catch (error) {
          void error;
          return { url: location.href, count: 0 };
        }
      },
      args: [selector],
    });
  } catch {
    return [];
  }
  return results
    .filter((entry) => (entry.result?.count ?? 0) > 0 && entry.result !== undefined)
    .map((entry) => ({ frameId: entry.frameId, url: entry.result!.url, count: entry.result!.count }));
}

interface FrameActionOutcome {
  ok: boolean;
  reason?: string;
  x?: number;
  y?: number;
  tag?: string;
  /** A file input: a synthetic click cannot open the picker, so it is recorded instead. */
  fileInput?: boolean;
}

/** Click an element inside one frame, with the same pointer/mouse sequence as the top frame. */
export async function clickInFrame(
  tabId: number,
  frameId: number,
  selector: string,
  button: "left" | "right" | "middle",
): Promise<FrameActionOutcome> {
  const number = button === "left" ? 0 : button === "middle" ? 1 : 2;
  const bits = button === "left" ? 1 : button === "middle" ? 4 : 2;
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (wanted: string, buttonNumber: number, buttonBits: number): FrameActionOutcome => {
      const el = document.querySelector(wanted);
      if (el === null) return { ok: false, reason: `no element matches ${wanted} in this frame` };
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch (error) {
        void error;
      }
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: buttonNumber,
      };
      const pointer = (type: string, held: number): PointerEvent =>
        new PointerEvent(type, Object.assign({}, base, { buttons: held, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      const mouse = (type: string, held: number): MouseEvent =>
        new MouseEvent(type, Object.assign({}, base, { buttons: held, detail: 1 }));
      el.dispatchEvent(pointer("pointerover", 0));
      el.dispatchEvent(pointer("pointerenter", 0));
      el.dispatchEvent(mouse("mouseover", 0));
      el.dispatchEvent(mouse("mouseenter", 0));
      el.dispatchEvent(pointer("pointermove", 0));
      el.dispatchEvent(mouse("mousemove", 0));
      if (typeof (el as HTMLElement).focus === "function") {
        try {
          (el as HTMLElement).focus({ preventScroll: true });
        } catch (error) {
          void error;
        }
      }
      el.dispatchEvent(pointer("pointerdown", buttonBits));
      el.dispatchEvent(mouse("mousedown", buttonBits));
      el.dispatchEvent(pointer("pointerup", 0));
      el.dispatchEvent(mouse("mouseup", 0));
      el.dispatchEvent(mouse("click", 0));
      if (buttonNumber === 2) el.dispatchEvent(mouse("contextmenu", 0));
      return {
        ok: true,
        x,
        y,
        tag: el.tagName.toLowerCase(),
        fileInput: el.tagName === "INPUT" && String((el as HTMLInputElement).type).toLowerCase() === "file",
      };
    },
    args: [selector, number, bits],
  });
  return results[0]?.result ?? { ok: false, reason: "the frame returned nothing" };
}

/**
 * Focus a field in a frame, selecting its contents when `selectAll` is asked for,
 * so the caller can then insert text through CDP into the focused element.
 */
export async function focusInFrame(
  tabId: number,
  frameId: number,
  selector: string,
  selectAll: boolean,
): Promise<FrameActionOutcome> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (wanted: string, select: boolean): FrameActionOutcome => {
      const el = document.querySelector(wanted);
      if (el === null) return { ok: false, reason: `no element matches ${wanted} in this frame` };
      const field = el as HTMLInputElement;
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
        field.focus({ preventScroll: true });
      } catch (error) {
        void error;
      }
      if (select && typeof field.select === "function") {
        try {
          field.select();
        } catch (error) {
          void error;
        }
      } else if (select && typeof field.setSelectionRange === "function") {
        try {
          field.setSelectionRange(0, String(field.value ?? "").length);
        } catch (error) {
          void error;
        }
      }
      return { ok: true, tag: el.tagName.toLowerCase() };
    },
    args: [selector, selectAll],
  });
  return results[0]?.result ?? { ok: false, reason: "the frame returned nothing" };
}

/** Scroll a container inside one frame. */
export async function scrollInFrame(
  tabId: number,
  frameId: number,
  selector: string | null,
  deltaX: number,
  deltaY: number,
): Promise<{
  ok: boolean;
  reason?: string;
  container?: string;
  moved?: boolean;
  before?: { top: number; left: number };
  after?: { top: number; left: number };
  maxScrollTop?: number;
  atLimit?: boolean;
}> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (wanted: string | null, dx: number, dy: number) => {
      const scrolls = (el: Element | null): boolean => {
        if (el === null || el.nodeType !== 1) return false;
        const style = getComputedStyle(el);
        const overflow = `${style.overflowY} ${style.overflowX}`;
        return (
          /(auto|scroll|overlay)/.test(overflow) &&
          ((el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 1 ||
            (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1)
        );
      };
      const nearest = (start: Element | null): HTMLElement => {
        let node: Element | null = start;
        while (node !== null && node.nodeType === 1) {
          if (scrolls(node)) return node as HTMLElement;
          node = node.parentElement;
        }
        return (document.scrollingElement ?? document.documentElement) as HTMLElement;
      };
      const start = wanted === null ? null : document.querySelector(wanted);
      if (wanted !== null && start === null) return { ok: false, reason: `no element matches ${wanted} in this frame` };
      const pick = wanted === null ? ((document.scrollingElement ?? document.documentElement) as HTMLElement) : nearest(start);
      const describe = pick === document.scrollingElement || pick === document.documentElement ? "document" : `${pick.tagName.toLowerCase()}${pick.id === "" ? "" : `#${pick.id}`}`;
      const before = { top: pick.scrollTop, left: pick.scrollLeft };
      try {
        pick.scrollBy({ top: dy, left: dx, behavior: "instant" });
      } catch (error) {
        pick.scrollTop += dy;
        pick.scrollLeft += dx;
        void error;
      }
      const after = { top: pick.scrollTop, left: pick.scrollLeft };
      const maxScrollTop = Math.max(0, pick.scrollHeight - pick.clientHeight);
      return {
        ok: true,
        container: describe,
        before,
        after,
        moved: before.top !== after.top || before.left !== after.left,
        maxScrollTop,
        atLimit: (dy > 0 && after.top >= maxScrollTop - 1) || (dy < 0 && after.top <= 0),
      };
    },
    args: [selector, deltaX, deltaY],
  });
  return results[0]?.result ?? { ok: false, reason: "the frame returned nothing" };
}

/** True when `selector` exists in any frame — used by `page.waitFor`. */
export async function selectorInAnyFrame(tabId: number, selector: string): Promise<boolean> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (wanted: string): number => {
        try {
          return document.querySelectorAll(wanted).length;
        } catch {
          return 0;
        }
      },
      args: [selector],
    });
    return results.some((entry) => (entry.result ?? 0) > 0);
  } catch {
    return false;
  }
}

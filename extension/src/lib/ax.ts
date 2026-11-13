/**
 * Shaping an accessibility tree for a language model.
 *
 * Chrome's `Accessibility.getFullAXTree` returns a few thousand nodes with
 * properties, sources and ignored-subtree markers. Handing that to a model is
 * both expensive and hard to act on, so this module turns it into a flat,
 * bounded list of the nodes that matter, and keeps the one identifier the next
 * milestone needs: the backend DOM node id.
 *
 * Pure: no chrome.*, no CDP types leaking out. The tree is passed in already
 * parsed, so the interesting rules (depth, truncation, visibility, what counts as
 * a name) are unit-tested rather than hoped for.
 */

import {
  AX_MAX_DEPTH,
  AX_NAME_MAX,
  AX_VALUE_MAX,
  type AxNode,
} from "@gb-ava/protocol";

/** The subset of a CDP AXNode this module reads. */
export interface RawAxNode {
  nodeId?: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  description?: { value?: unknown };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
  childIds?: string[];
}

/** Roles that carry no information for an agent and only pad the output. */
const NOISE_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "InlineTextBox",
  "LineBreak",
  "StaticTextListMarker",
]);

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function clamp(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, max)}…`, truncated: true };
}

function property(node: RawAxNode, name: string): unknown {
  const found = node.properties?.find((entry) => entry.name === name);
  return found?.value?.value;
}

function booleanProperty(node: RawAxNode, name: string): boolean {
  return property(node, name) === true;
}

/** Roles whose checked state is worth reporting. Everything else is `null`. */
const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

/**
 * The checked state of a checkable node, or `null`.
 *
 * Chrome reports this as the `checked` property for most controls; a native
 * `<input type=checkbox>` wrapped in a label surfaces it the same way. Reading it
 * here is what lets an agent verify a tick from the tree alone instead of needing
 * `page.evaluate` (#25).
 */
function checkedState(node: RawAxNode, role: string): boolean | null {
  if (!CHECKABLE_ROLES.has(role)) return null;
  const checked = property(node, "checked");
  if (typeof checked === "boolean") return checked;
  // Some controls report the state as the string "true" / "false" / "mixed".
  if (checked === "true") return true;
  if (checked === "false") return false;
  // A tri-state checkbox that is neither: report unchecked rather than guess "on".
  return null;
}

/**
 * Bounds are in CSS pixels, from the node's `bounds` property when Chrome
 * provides it. A node with no box (a document, a hidden element) gets null
 * rather than a zeroed rectangle, so a caller cannot mistake "no box" for
 * "at 0,0 with no size".
 */
function boundsOf(node: RawAxNode): AxNode["bounds"] {
  const raw = property(node, "bounds");
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const x = record["x"];
  const y = record["y"];
  const width = record["width"];
  const height = record["height"];
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Flatten the tree breadth-first from the root, skipping ignored nodes and their
 * subtrees, so the order matches what a human reading the page top-down would
 * find. Depth is capped: a pathological page must not turn into a recursion
 * problem, and past that depth the structure is repeated chrome anyway.
 */
export function shapeAxTree(
  nodes: readonly RawAxNode[],
  options: { limit: number; includeInvisible: boolean },
): { nodes: AxNode[]; totalNodes: number; truncated: boolean } {
  const byId = new Map<string, RawAxNode>();
  for (const node of nodes) {
    if (typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }

  const root = nodes.find((node) => node.ignored !== true && node.role?.value === "RootWebArea") ?? nodes[0];
  if (root === undefined) return { nodes: [], totalNodes: 0, truncated: false };

  const out: AxNode[] = [];
  let seen = 0;
  let truncated = false;
  const queue: Array<{ node: RawAxNode; depth: number }> = [{ node: root, depth: 0 }];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined) break;
    const { node, depth } = entry;


    const role = text(node.role?.value);
    const visible = !booleanProperty(node, "hidden") && !booleanProperty(node, "invisible");
    // An ignored node is not itself rendered (Chrome ignores generic wrappers), but
    // its children are: `getFullAXTree` does not hoist them, so the walk must go
    // through it rather than stopping at it. (Stopping there returned a tree of one
    // RootWebArea — found by the integration test.)
    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is RawAxNode => child !== undefined);

    const keep = node.ignored !== true && !NOISE_ROLES.has(role) && (options.includeInvisible || visible);
    if (keep) {
      if (out.length >= options.limit) {
        truncated = true;
        break;
      }
      seen += 1;
      const name = clamp(text(node.name?.value), AX_NAME_MAX);
      const value = text(node.value?.value);
      out.push({
        nodeId: typeof node.backendDOMNodeId === "number" ? node.backendDOMNodeId : null,
        role,
        name: name.value,
        value: value.length > 0 ? clamp(value, AX_VALUE_MAX).value : null,
        description: clamp(text(node.description?.value), AX_VALUE_MAX).value || null,
        visible,
        disabled: booleanProperty(node, "disabled") || booleanProperty(node, "unavailable"),
        focused: booleanProperty(node, "focused"),
        checked: checkedState(node, role),
        bounds: boundsOf(node),
        childCount: children.length,
      });
    }

    if (depth + 1 <= AX_MAX_DEPTH) {
      for (const child of children) queue.push({ node: child, depth: depth + 1 });
    }
  }

  // `totalNodes` and `truncated` count the same population the caller would have
  // received: eligible, non-noise, and (unless asked otherwise) visible. Counting
  // hidden nodes there made `truncated` claim a cut that never happened.
  const eligible = nodes.filter((node) => {
    if (node.ignored === true) return false;
    const role = text(node.role?.value);
    if (NOISE_ROLES.has(role)) return false;
    const visible = !booleanProperty(node, "hidden") && !booleanProperty(node, "invisible");
    return options.includeInvisible || visible;
  }).length;
  return { nodes: out, totalNodes: eligible, truncated: truncated || out.length < eligible };
}

/**
 * Truncate page text at a bound, on a word boundary where possible, and say so.
 * A caller that got a truncated read must be able to tell, or it will reason
 * about half a page as if it were the whole thing.
 */
export function clampText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const slice = text.slice(0, limit);
  const boundary = slice.lastIndexOf(" ");
  const cut = boundary > limit * 0.8 ? slice.slice(0, boundary) : slice;
  return { text: `${cut}\n…[truncated ${text.length - cut.length} characters]`, truncated: true };
}

/** The node an agent means by an id it was given earlier. */
export function findNodeById(nodes: readonly AxNode[], nodeId: number): AxNode | null {
  return nodes.find((node) => node.nodeId === nodeId) ?? null;
}

import { describe, expect, it } from "vitest";
import { clampText, findNodeById, shapeAxTree, type RawAxNode } from "../../extension/src/lib/ax.js";
import { decodePngSize } from "../../extension/src/lib/read-ops.js";
import { parseGetTextParams, parseReadAxParams, parseScreenshotParams } from "@gb-ava/protocol";

const node = (id: string, role: string, extra: Partial<RawAxNode> = {}): RawAxNode => ({
  nodeId: id,
  role: { value: role },
  name: { value: role },
  ...extra,
});

describe("accessibility shaping", () => {
  const tree: RawAxNode[] = [
    node("1", "RootWebArea", { childIds: ["2", "3", "4"] }),
    node("2", "textbox", { name: { value: "Email" }, backendDOMNodeId: 101, properties: [{ name: "focused", value: { value: true } }] }),
    node("3", "button", { name: { value: "Sign in" }, backendDOMNodeId: 102, properties: [{ name: "bounds", value: { value: { x: 10, y: 20, width: 30, height: 40 } } }] }),
    node("4", "generic", { backendDOMNodeId: 103 }),
    node("5", "ignored subtree", { ignored: true, childIds: ["6"] }),
    node("6", "StaticText", { name: { value: "hidden child" } }),
  ];

  it("keeps the backend node ids the next milestone addresses", () => {
    const shaped = shapeAxTree(tree, { limit: 100, includeInvisible: true });
    expect(shaped.nodes.find((entry) => entry.role === "button")?.nodeId).toBe(102);
    expect(findNodeById(shaped.nodes, 102)?.name).toBe("Sign in");
  });

  it("walks through ignored wrappers, because their children are the real content", () => {
    const wrapped: RawAxNode[] = [
      node("1", "RootWebArea", { childIds: ["2"] }),
      node("2", "generic", { ignored: true, childIds: ["3"] }),
      node("3", "button", { name: { value: "Continue" }, backendDOMNodeId: 201 }),
    ];
    const shaped = shapeAxTree(wrapped, { limit: 10, includeInvisible: true });
    expect(shaped.nodes.map((entry) => entry.role)).toEqual(["RootWebArea", "button"]);
    expect(shaped.nodes[1]?.nodeId).toBe(201);
  });

  it("drops noise roles and the ignored nodes themselves", () => {
    const shaped = shapeAxTree(tree, { limit: 100, includeInvisible: true });
    const roles = shaped.nodes.map((entry) => entry.role);
    expect(roles).toContain("textbox");
    expect(roles).toContain("button");
    expect(roles).not.toContain("generic");
    expect(roles).not.toContain("StaticText");
    expect(roles.filter((role) => role === "StaticText")).toHaveLength(0);
  });

  it("carries state and bounds, and nulls a box a node does not have", () => {
    const shaped = shapeAxTree(tree, { limit: 100, includeInvisible: true });
    const textbox = shaped.nodes.find((entry) => entry.role === "textbox");
    const button = shaped.nodes.find((entry) => entry.role === "button");
    expect(textbox?.focused).toBe(true);
    expect(textbox?.bounds).toBeNull();
    expect(button?.bounds).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("reports a truncated read instead of silently cutting the tree", () => {
    const many: RawAxNode[] = [node("1", "RootWebArea", { childIds: ["2", "3", "4"] })];
    many.push(node("2", "button"), node("3", "button"), node("4", "button"));
    const shaped = shapeAxTree(many, { limit: 2, includeInvisible: true });
    expect(shaped.nodes).toHaveLength(2);
    expect(shaped.truncated).toBe(true);
  });

  it("does not claim a truncation it did not perform", () => {
    // A hidden node is not eligible, so excluding it is not a cut.
    const withHidden: RawAxNode[] = [
      node("1", "RootWebArea", { childIds: ["2", "3"] }),
      node("2", "button", { backendDOMNodeId: 11 }),
      node("3", "button", { backendDOMNodeId: 12, properties: [{ name: "hidden", value: { value: true } }] }),
    ];
    const shaped = shapeAxTree(withHidden, { limit: 10, includeInvisible: false });
    expect(shaped.nodes.map((entry) => entry.nodeId)).toEqual([null, 11]);
    expect(shaped.totalNodes).toBe(2);
    expect(shaped.truncated).toBe(false);

    const all = shapeAxTree(withHidden, { limit: 10, includeInvisible: true });
    expect(all.nodes.map((entry) => entry.nodeId)).toEqual([null, 11, 12]);
    expect(all.truncated).toBe(false);
  });

  it("clamps a long description the same way it clamps a name", () => {
    const verbose = node("1", "button", {
      backendDOMNodeId: 5,
      description: { value: "x".repeat(1000) },
    });
    const shaped = shapeAxTree([verbose], { limit: 5, includeInvisible: true });
    expect((shaped.nodes[0]?.description ?? "").length).toBeLessThanOrEqual(301);
  });

  it("never invents a node id", () => {
    const shaped = shapeAxTree([node("1", "button")], { limit: 10, includeInvisible: true });
    expect(shaped.nodes[0]?.nodeId).toBeNull();
  });

  it("survives a tree with no root and a cyclic child reference", () => {
    const cyclic: RawAxNode[] = [node("1", "RootWebArea", { childIds: ["2"] }), node("2", "group", { childIds: ["1"] })];
    // The BFS is depth-capped, so a cycle terminates rather than hangs.
    const shaped = shapeAxTree(cyclic, { limit: 50, includeInvisible: true });
    expect(shaped.nodes.length).toBeGreaterThan(0);
    expect(shaped.nodes.length).toBeLessThanOrEqual(50);
  });
});

describe("text bounds", () => {
  it("returns short text untouched", () => {
    expect(clampText("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("cuts on a word boundary when it can, and says how much was dropped", () => {
    const text = `${"word ".repeat(50)}end`;
    const result = clampText(text, 100);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(text.length);
    expect(result.text).toMatch(/…\[truncated \d+ characters\]$/);
  });
});

describe("png header", () => {
  it("reads dimensions from a real 1x1 PNG", () => {
    // 1x1 transparent PNG.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    expect(decodePngSize(png)).toEqual({ width: 1, height: 1 });
  });

  it("returns null for something that is not a PNG", () => {
    expect(decodePngSize("bm90IGEgcG5n")).toBeNull();
  });
});

describe("M2 parameters", () => {
  it("page.readAX needs a tab and bounds its limit", () => {
    expect(parseReadAxParams({ tabId: 3 })).toEqual({
      ok: true,
      value: { tabId: 3, limit: 400, includeInvisible: false },
    });
    expect(parseReadAxParams({ tabId: 3, limit: 0 }).ok).toBe(false);
    expect(parseReadAxParams(undefined).ok).toBe(false);
    expect(parseReadAxParams({ tabId: 3, tabid: 4 }).ok).toBe(false);
  });

  it("page.getText needs a tab and defaults a bounded limit", () => {
    expect(parseGetTextParams({ tabId: 9 })).toEqual({ ok: true, value: { tabId: 9, limit: 20_000 } });
    expect(parseGetTextParams({ tabId: 9, limit: 200_001 }).ok).toBe(false);
  });

  it("page.screenshot needs a tab and opts into staleness detection", () => {
    expect(parseScreenshotParams({ tabId: 2, detectStale: true })).toEqual({
      ok: true,
      value: { tabId: 2, detectStale: true },
    });
    expect(parseScreenshotParams({ tabId: 2, fullPage: true }).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { AUDIT_CAPACITY, AuditRing, outcomeFor, summariseArgs, type AuditEntry } from "../../extension/src/lib/audit.js";

const entry = (index: number): AuditEntry => ({
  at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  method: "tabs.list",
  tabId: index,
  args: `limit:${index}`,
  outcome: "ok",
  code: null,
  durationMs: 1,
});

describe("the audit ring", () => {
  it("keeps at most its capacity, dropping the oldest", () => {
    const ring = new AuditRing(3);
    for (let index = 1; index <= 5; index += 1) ring.record(entry(index));
    expect(ring.size()).toBe(3);
    const recent = ring.recent(10);
    expect(recent.map((item) => item.tabId)).toEqual([5, 4, 3]);
  });

  it("has a fixed production capacity", () => {
    const ring = new AuditRing();
    for (let index = 0; index < AUDIT_CAPACITY + 25; index += 1) ring.record(entry(index));
    expect(ring.size()).toBe(AUDIT_CAPACITY);
  });

  it("returns copies, so a caller cannot rewrite history", () => {
    const ring = new AuditRing(2);
    ring.record(entry(1));
    const [first] = ring.recent(1);
    first!.args = "tampered";
    expect(ring.recent(1)[0]?.args).toBe("limit:1");
  });

  it("bounds the snapshot it hands to health", () => {
    const ring = new AuditRing(100);
    for (let index = 0; index < 30; index += 1) ring.record(entry(index));
    const snapshot = ring.snapshot(5);
    expect(snapshot.size).toBe(30);
    expect(snapshot.capacity).toBe(100);
    expect(snapshot.recent).toHaveLength(5);
  });
});

describe("argument summaries", () => {
  it("never records what was typed, only how much", () => {
    const summary = summariseArgs("page.type", { tabId: 7, selector: "#password", text: "hunter2" });
    expect(summary).toContain("tabId:7");
    expect(summary).toContain("selector:#password");
    expect(summary).toContain("text:7ch");
    expect(summary).not.toContain("hunter2");
  });

  it("keeps an expression's length, not its body", () => {
    const summary = summariseArgs("page.evaluate", { tabId: 1, expression: "document.title" });
    expect(summary).toContain("expression:14ch");
    expect(summary).not.toContain("document.title");
  });

  it("does not keep a screenshot's base64", () => {
    const summary = summariseArgs("page.screenshot", { tabId: 2, png: "iVBORw0KGgo".repeat(500) });
    expect(summary).toContain("png");
    expect(summary.length).toBeLessThan(80);
  });

  it("bounds a long URL and a long argument list", () => {
    const long = summariseArgs("tabs.navigate", { tabId: 3, url: `https://example.com/${"a".repeat(300)}` });
    expect(long.length).toBeLessThanOrEqual(201);
    expect(long.endsWith("…")).toBe(true);
  });

  it("counts files rather than listing them", () => {
    const summary = summariseArgs("page.upload", { tabId: 4, files: ["/a", "/b"] });
    expect(summary).toContain("files:2");
  });

  it("is empty for a call with no parameters", () => {
    expect(summariseArgs("health", undefined)).toBe("");
    expect(summariseArgs("health", {})).toBe("");
  });
});

describe("outcomes", () => {
  it("separates a human-blocked command from a failure", () => {
    expect(outcomeFor(null)).toBe("ok");
    expect(outcomeFor("needs_human")).toBe("needs_human");
    expect(outcomeFor("timeout")).toBe("error");
  });
});

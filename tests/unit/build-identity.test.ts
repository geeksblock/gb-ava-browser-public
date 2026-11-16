/**
 * The build identity rule, tested because its first review found it
 * collapsing two dirty builds of the same commit into one id — which made a
 * genuinely stale extension report "same build, not stale".
 */
import { describe, expect, it } from "vitest";
import { deriveBuildIdentity } from "../../scripts/build-identity.mjs";

describe("build identity derivation", () => {
  it("a clean tree at a commit is exactly that commit", () => {
    const first = deriveBuildIdentity({ commit: "5c996186c457", dirty: false, builtAt: "2026-11-12T02:08:24.784Z" });
    const later = deriveBuildIdentity({ commit: "5c996186c457", dirty: false, builtAt: "2026-11-13T09:00:00.000Z" });
    expect(first).toEqual({ id: "5c996186c457", builtAt: "2026-11-12T02:08:24.784Z", clean: true });
    // Rebuilding one commit is the same code; the id must stay stable so a
    // reloaded extension is not reported as a mismatch forever.
    expect(later.id).toBe(first.id);
  });

  it("two dirty builds of the same commit are different builds and get different ids", () => {
    const stale = deriveBuildIdentity({ commit: "5c996186c457", dirty: true, builtAt: "2026-11-12T02:08:24.784Z" });
    const fresh = deriveBuildIdentity({ commit: "5c996186c457", dirty: true, builtAt: "2026-11-12T03:15:00.000Z" });
    expect(stale.id).not.toBe(fresh.id);
    expect(stale.id).toContain("5c996186c457");
    expect(stale.id).toContain("dirty");
    expect(fresh.id).toContain("5c996186c457");
    expect(fresh.id).toContain("dirty");
    expect(stale.clean).toBe(false);
  });

  it("a git-less build (no commit) gets a unique id per build", () => {
    const first = deriveBuildIdentity({ commit: "unknown", dirty: false, builtAt: "2026-11-12T02:08:24.784Z" });
    const second = deriveBuildIdentity({ commit: "unknown", dirty: false, builtAt: "2026-11-12T03:15:00.000Z" });
    expect(first.id).not.toBe(second.id);
    expect(first.id.startsWith("unknown-")).toBe(true);
    expect(first.clean).toBe(false);
  });

  it("treats an empty commit as unknown rather than as a clean id", () => {
    const identity = deriveBuildIdentity({ commit: "   ", dirty: false, builtAt: "2026-11-12T02:08:24.784Z" });
    expect(identity.clean).toBe(false);
    expect(identity.id.startsWith("unknown-")).toBe(true);
  });

  it("falls back to now when no build time is supplied", () => {
    const identity = deriveBuildIdentity({ commit: "unknown", dirty: false, builtAt: "" });
    expect(identity.builtAt.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(identity.builtAt))).toBe(false);
    expect(identity.id).toContain(identity.builtAt);
  });
});

/**
 * Attach-failure reporting.
 *
 * A real report showed `cannot attach to tab N: Cannot access a chrome-extension://
 * URL of different extension` carrying `hint: "Close DevTools on that tab and retry"`
 * — but no DevTools was open. The hint was emitted by the *generic* catch-all, which
 * cannot know the cause, so it asserted one that was usually wrong.
 *
 * These tests pin what the caller is told: only a cause that is actually evidenced,
 * plus the diagnostic fields that make the next report actionable.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { send } from "../../extension/src/lib/debugger.js";
import { CommandError } from "../../extension/src/lib/errors.js";

interface Harness {
  chrome: any;
  /** Make chrome.debugger.attach fail with this message. */
  failAttachWith: (message: string) => void;
  setTabUrl: (url: string | null) => void;
}

function install(): Harness {
  let attachFailure: string | null = "Cannot access a chrome-extension:// URL of different extension";
  let tabUrl: string | null = "https://entra.microsoft.com/";

  const chrome = {
    debugger: {
      onDetach: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) },
      onEvent: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) },
      attach: vi.fn(async () => {
        if (attachFailure !== null) throw new Error(attachFailure);
      }),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({ product: "Chrome" })),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        if (tabUrl === null) throw new Error(`No tab with id: ${id}.`);
        return { id, url: tabUrl };
      }),
    },
  };
  (globalThis as any).chrome = chrome;
  return {
    chrome,
    failAttachWith: (message: string) => {
      attachFailure = message;
    },
    setTabUrl: (url: string | null) => {
      tabUrl = url;
    },
  };
}

function detailOf(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(CommandError);
  return ((error as CommandError).payload.detail ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe("an attach failure reports only a cause it can evidence", () => {
  it("does not tell the caller to close DevTools for a chrome-extension refusal", async () => {
    const harness = install();
    harness.failAttachWith("Cannot access a chrome-extension:// URL of different extension");
    harness.setTabUrl("https://entra.microsoft.com/");

    const error = await send(1, "Runtime.evaluate").catch((e: unknown) => e);
    const detail = detailOf(error);

    // The reported defect: this hint sent the caller hunting for DevTools that
    // was never open.
    expect(String(detail["hint"])).not.toContain("Close DevTools on that tab and retry");
    expect(String(detail["hint"])).not.toMatch(/^Another debugger owns this tab/);
  });

  it("keeps the verbatim Chrome message for diagnosis", async () => {
    const harness = install();
    harness.failAttachWith("Cannot access a chrome-extension:// URL of different extension");

    const error = await send(1, "Runtime.evaluate").catch((e: unknown) => e);
    // The message already carries it, and the detail now does too, so a report can
    // be triaged without re-running the failure.
    expect(detailOf(error)["chromeMessage"]).toBe("Cannot access a chrome-extension:// URL of different extension");
  });

  it("includes the tab's current URL, which is the evidence for that class of failure", async () => {
    const harness = install();
    harness.setTabUrl("chrome-extension://abcdefghijklmnop/options.html");

    const error = await send(1, "Runtime.evaluate").catch((e: unknown) => e);
    // When the URL really is a chrome-extension page, the report becomes obvious —
    // from the scheme alone. Which extension, and which page, stays hidden: the
    // same rule tabs.list applies to browser, extension and local-file pages.
    expect(detailOf(error)["tabUrl"]).toBe("chrome-extension://…");
  });

  it("still names DevTools when another debugger is the evidenced cause", async () => {
    const harness = install();
    harness.failAttachWith("Another debugger is already attached to the tab");
    // The probe that decides whether the existing session is ours also fails, so
    // this is genuinely another owner.
    harness.chrome.debugger.sendCommand.mockImplementation(async () => {
      throw new Error("not attached");
    });

    const error = await send(1, "Runtime.evaluate").catch((e: unknown) => e);
    expect(detailOf(error)["hint"]).toContain("Close DevTools");
  });

  it("does not let a missing tab replace the attach error", async () => {
    const harness = install();
    harness.setTabUrl(null); // chrome.tabs.get throws
    const error = await send(1, "Runtime.evaluate").catch((e: unknown) => e);
    // The diagnostic is best-effort; the caller still gets the attach failure.
    expect((error as CommandError).payload.code).toBe("debugger_unavailable");
    expect(detailOf(error)["tabUrl"]).toBeNull();
  });
});

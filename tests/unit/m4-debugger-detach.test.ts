/**
 * a closed tab must not be reported as a retryable debugger problem.
 *
 * `debugger_unavailable` is `retryable: true`. When a tab closes, Chrome reports it
 * as a detach, which used to land on that code — so a caller branching on
 * retryability would retry a tab that no longer exists, forever.
 *
 * The distinction cannot be made from the error text (both causes say "detached"),
 * so the code asks Chrome whether the tab still exists. These tests pin both halves.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { send } from "../../extension/src/lib/debugger.js";
import { CommandError } from "../../extension/src/lib/errors.js";

interface Harness {
  chrome: any;
  /** Make the next real command fail with this message. */
  failNextCommand: (message: string) => void;
  /** Whether chrome.tabs.get should claim the tab exists. */
  setTabExists: (exists: boolean) => void;
}

function install(): Harness {
  let tabExists = true;
  let failure: string | null = null;
  const chrome = {
    debugger: {
      onDetach: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) },
      onEvent: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) },
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async (_target: unknown, method: string) => {
        if (failure !== null) throw new Error(failure);
        // The attach probe and any normal command.
        return method === "Browser.getVersion" ? { product: "Chrome" } : {};
      }),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        if (!tabExists) throw new Error(`No tab with id: ${id}.`);
        return { id, url: "https://example.test/" };
      }),
    },
  };
  (globalThis as any).chrome = chrome;
  return {
    chrome,
    failNextCommand: (message: string) => {
      failure = message;
    },
    setTabExists: (exists: boolean) => {
      tabExists = exists;
    },
  };
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(CommandError);
  return (error as CommandError).payload.code;
}

function retryableOf(error: unknown): unknown {
  return (error as CommandError).payload.retryable;
}

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe("a detach caused by a closed tab is not_found, not a retryable debugger fault", () => {
  it("reports not_found when the tab is gone, and marks it not retryable", async () => {
    const harness = install();
    // Attach cleanly first, then the tab vanishes and the next command detaches.
    await send(1, "Runtime.evaluate");
    harness.failNextCommand("Detached while handling command.");
    harness.setTabExists(false);

    const error = await send(1, "Runtime.evaluate").catch((e: unknown) => e);

    expect(codeOf(error)).toBe("not_found");
    // This is the defect: a retryable code sends a caller into a loop on a dead tab.
    expect(retryableOf(error)).toBe(false);
    expect((error as Error).message).toContain("no longer exists");
  });

  it("still reports debugger_unavailable when the tab is alive but the session died", async () => {
    const harness = install();
    await send(1, "Runtime.evaluate");
    harness.failNextCommand("Detached while handling command.");
    harness.setTabExists(true);

    const error = await send(1, "Runtime.evaluate").catch((e: unknown) => e);

    // DevTools attaching is the real cause here, and retrying after closing it is
    // exactly what the caller should do — so this one stays retryable.
    expect(codeOf(error)).toBe("debugger_unavailable");
    expect(retryableOf(error)).toBe(true);
  });

  it("asks Chrome rather than guessing from the message", async () => {
    const harness = install();
    await send(1, "Runtime.evaluate");
    harness.failNextCommand("Debugger is not attached to the tab with id: 1.");
    harness.setTabExists(false);

    await send(1, "Runtime.evaluate").catch(() => undefined);

    // The tab lookup is the evidence; the wording of the error is not.
    expect(harness.chrome.tabs.get).toHaveBeenCalled();
  });

  it("keeps a plain unknown failure as internal and not retryable", async () => {
    const harness = install();
    await send(1, "Runtime.evaluate");
    harness.failNextCommand("something entirely unexpected");

    const error = await send(1, "Runtime.evaluate").catch((e: unknown) => e);
    expect(codeOf(error)).toBe("internal");
    expect(retryableOf(error)).toBe(false);
  });
});

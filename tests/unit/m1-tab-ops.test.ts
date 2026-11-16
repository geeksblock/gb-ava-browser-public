/**
 * tab-ops.ts against a scripted chrome.tabs / chrome.tabGroups.
 *
 * Every call here is one the service worker makes, so what is pinned is the
 * command's observable contract: which protocol error a caller sees, and what
 * the reply claims happened.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateCommand,
  closeCommand,
  groupCommand,
  navigateCommand,
  requireTabs,
  ungroupCommand,
} from "../../extension/src/lib/tab-ops.js";
import { CommandError } from "../../extension/src/lib/errors.js";

interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  url: string;
  title: string;
  status: string;
  groupId: number;
}

function tab(over: Partial<FakeTab> = {}): FakeTab {
  return {
    id: 1,
    windowId: 10,
    index: 0,
    active: false,
    url: "https://a.test/",
    title: "A",
    status: "complete",
    groupId: -1,
    ...over,
  };
}

interface Harness {
  tabs: FakeTab[];
  groups: Map<number, { id: number; color: string; title: string; collapsed: boolean }>;
  chrome: any;
}

function install(tabs: FakeTab[], options: { groupFails?: boolean } = {}): Harness {
  const groups = new Map<number, any>();
  let nextGroupId = 7;
  const chrome = {
    tabs: {
      query: vi.fn(async () => tabs.map((t) => ({ ...t }))),
      get: vi.fn(async (id: number) => {
        const found = tabs.find((t) => t.id === id);
        if (!found) throw new Error(`No tab with id: ${id}.`);
        return { ...found };
      }),
      update: vi.fn(async (id: number, props: any) => {
        const found = tabs.find((t) => t.id === id);
        if (!found) throw new Error(`No tab with id: ${id}.`);
        Object.assign(found, props);
        return { ...found };
      }),
      remove: vi.fn(async (id: number) => {
        const index = tabs.findIndex((t) => t.id === id);
        if (index < 0) throw new Error(`No tab with id: ${id}.`);
        tabs.splice(index, 1);
      }),
      group: vi.fn(async (opts: any) => {
        if (options.groupFails) throw new Error("Tabs can only be moved to and from normal windows.");
        let groupId = opts.groupId;
        if (groupId === undefined) {
          groupId = nextGroupId++;
          groups.set(groupId, { id: groupId, color: "grey", title: "", collapsed: true });
        } else if (!groups.has(groupId)) {
          groups.set(groupId, { id: groupId, color: "grey", title: "", collapsed: true });
        }
        for (const id of opts.tabIds) {
          const found = tabs.find((t) => t.id === id);
          if (found) found.groupId = groupId;
        }
        return groupId;
      }),
      ungroup: vi.fn(async (ids: number[]) => {
        for (const id of ids) {
          const found = tabs.find((t) => t.id === id);
          if (found) found.groupId = -1;
        }
      }),
    },
    tabGroups: {
      get: vi.fn(async (id: number) => {
        const found = groups.get(id);
        if (!found) throw new Error(`No group with id: ${id}.`);
        return { ...found };
      }),
      update: vi.fn(async (id: number, props: any) => {
        const found = groups.get(id);
        if (!found) throw new Error(`No group with id: ${id}.`);
        Object.assign(found, props);
        return { ...found };
      }),
    },
    windows: {
      get: vi.fn(async (id: number) => ({ id, focused: false })),
      update: vi.fn(async (id: number) => ({ id, focused: true })),
    },
  };
  (globalThis as any).chrome = chrome;
  return { tabs, groups, chrome };
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(CommandError);
  return (error as CommandError).payload.code;
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).chrome;
});

describe("requireTabs — an unknown tab is an error, never a substitution", () => {
  it("names every missing id and nothing else", async () => {
    install([tab({ id: 1 }), tab({ id: 2 })]);
    await expect(requireTabs([1])).resolves.toHaveLength(1);
    const error = await requireTabs([1, 9, 12]).catch((e) => e);
    expect(codeOf(error)).toBe("not_found");
    expect((error as CommandError).payload.detail).toEqual({ tabIds: [9, 12] });
  });

  it("returns exactly the requested set, once per id", async () => {
    install([tab({ id: 1, title: "one" }), tab({ id: 2, title: "two" }), tab({ id: 3, title: "three" })]);
    const tabs = await requireTabs([2, 3]);
    expect(tabs.map((t) => t.id).sort()).toEqual([2, 3]);
  });
});

describe("tabs.activate", () => {
  it("reports what happened, and does not raise the window unless asked", async () => {
    const h = install([tab({ id: 1, windowId: 10, active: false }), tab({ id: 2, active: true })]);
    const result: any = await activateCommand({ tabId: 1, focusWindow: false });
    expect(result).toMatchObject({ tabId: 1, activated: true, windowId: 10, windowRaised: false, wasActive: false });
    expect(h.chrome.windows.update).not.toHaveBeenCalled();
  });

  it("raises the window only when focusWindow was asked for", async () => {
    const h = install([tab({ id: 1, windowId: 10 })]);
    const result: any = await activateCommand({ tabId: 1, focusWindow: true });
    expect(h.chrome.windows.update).toHaveBeenCalledWith(10, { focused: true });
    expect(result.windowRaised).toBe(true);
  });

  it("a tab that vanished between the list and the update is not_found, not internal", async () => {
    // The tab is in the list `requireTabs` reads, then gone when Chrome is asked
    // to select it. That is the same race the module handles on every other path.
    const h = install([tab({ id: 1, windowId: 10 })]);
    h.chrome.tabs.update.mockImplementationOnce(async () => {
      throw new Error("No tab with id: 1.");
    });
    const error = await activateCommand({ tabId: 1, focusWindow: false }).catch((e) => e);
    expect(codeOf(error)).toBe("not_found");
  });
});

describe("tabs.close", () => {
  it("closes exactly the tab it was given", async () => {
    const h = install([tab({ id: 1 }), tab({ id: 2 })]);
    const result: any = await closeCommand({ tabId: 2 });
    expect(result.closedTabId).toBe(2);
    expect(h.chrome.tabs.remove).toHaveBeenCalledWith(2);
    expect(h.tabs.map((t) => t.id)).toEqual([1]);
  });

  it("refuses an id that is not a live tab, before touching anything", async () => {
    const h = install([tab({ id: 1 })]);
    const error = await closeCommand({ tabId: 5 }).catch((e) => e);
    expect(codeOf(error)).toBe("not_found");
    expect(h.chrome.tabs.remove).not.toHaveBeenCalled();
  });
});

describe("tabs.ungroup", () => {
  it("leaves the tabs open and only touches the ones actually in a group", async () => {
    const h = install([tab({ id: 1, groupId: 7 }), tab({ id: 2, groupId: -1 })]);
    const result: any = await ungroupCommand({ tabIds: [1, 2] });
    expect(result.ungroupedTabIds).toEqual([1]);
    expect(h.chrome.tabs.ungroup).toHaveBeenCalledWith([1]);
    expect(h.tabs).toHaveLength(2);
  });

  it("does not call chrome.tabs.ungroup with an empty list", async () => {
    // Chrome refuses an empty array ("Array must contain at least 1"), so a no-op
    // must be a no-op rather than a thrown error on an already-clean set.
    const h = install([tab({ id: 1 })]);
    const result: any = await ungroupCommand({ tabIds: [1] });
    expect(result.ungroupedTabIds).toEqual([]);
    expect(h.chrome.tabs.ungroup).not.toHaveBeenCalled();
  });
});

describe("tabs.group", () => {
  it("paints red/Ava and re-asserts it on a human's recoloured group", async () => {
    const h = install([tab({ id: 1 }), tab({ id: 2 })]);
    const first: any = await groupCommand({ tabIds: [1, 2] });
    expect(first).toMatchObject({ color: "red", title: "Ava", tabIds: [1, 2] });
    h.groups.set(first.groupId, { id: first.groupId, color: "blue", title: "mine", collapsed: true });
    await groupCommand({ tabIds: [1, 2], groupId: first.groupId });
    expect(h.groups.get(first.groupId)).toMatchObject({ color: "red", title: "Ava", collapsed: false });
  });

  // a dead id the *marker* remembers recovers, because that is the agent's own
  // bookkeeping going stale. A dead id the *caller* named does not — see
  // tests/unit/tab-ops-group-id.test.ts, which pins the not_found answer.
  it("falls back to a fresh group exactly once when the remembered id is dead", async () => {
    const h = install([tab({ id: 1 })]);
    h.chrome.tabs.group.mockImplementationOnce(async () => {
      throw new Error("No group with id: 999");
    });
    const result: any = await groupCommand({ tabIds: [1], rememberedGroupId: 999 });
    expect(result.groupId).toBe(7);
    expect(h.chrome.tabs.group).toHaveBeenCalledTimes(2);
    expect(h.chrome.tabs.group.mock.calls[1][0]).toEqual({ tabIds: [1] });
  });

  it("an explicit groupId is honoured even with no remembered marker", async () => {
    const h = install([tab({ id: 1 })]);
    h.groups.set(3, { id: 3, color: "grey", title: "", collapsed: false });
    const result: any = await groupCommand({ tabIds: [1], groupId: 3 });
    expect(result.groupId).toBe(3);
  });
});

describe("tabs.navigate", () => {
  it("refuses a URL a page cannot be, before any tab call", async () => {
    const h = install([tab({ id: 1 })]);
    const error = await navigateCommand({ tabId: 1, url: "javascript:void(0)" }).catch((e) => e);
    expect(codeOf(error)).toBe("invalid_request");
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("refuses a URL longer than the protocol bound", async () => {
    install([tab({ id: 1 })]);
    const error = await navigateCommand({ tabId: 1, url: `https://a.test/${"x".repeat(2049)}` }).catch((e) => e);
    expect(codeOf(error)).toBe("invalid_request");
  });

  it("reports not_found for a tab that is not there", async () => {
    const h = install([tab({ id: 1 })]);
    const error = await navigateCommand({ tabId: 9, url: "https://a.test/" }).catch((e) => e);
    expect(codeOf(error)).toBe("not_found");
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("reports not_found when the tab closes mid-navigation", async () => {
    vi.useFakeTimers();
    const h = install([tab({ id: 1 })]);
    h.chrome.tabs.get.mockImplementation(async () => {
      throw new Error("No tab with id: 1.");
    });
    const pending = navigateCommand({ tabId: 1, url: "https://a.test/" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(300);
    expect(codeOf(await pending)).toBe("not_found");
  });

  it("answers complete once the tab has landed at the target", async () => {
    vi.useFakeTimers();
    const h = install([tab({ id: 1, url: "https://a.test/old" })]);
    h.chrome.tabs.update.mockImplementationOnce(async (id: number, props: any) => {
      const found = h.tabs.find((t) => t.id === id)!;
      found.status = "loading";
      setTimeout(() => {
        found.url = props.url;
        found.status = "complete";
      }, 400);
      return { ...found };
    });
    const pending = navigateCommand({ tabId: 1, url: "https://a.test/new" });
    await vi.advanceTimersByTimeAsync(1000);
    const result: any = await pending;
    expect(result).toMatchObject({ tabId: 1, url: "https://a.test/new", status: "complete" });
  });

  it("is a timeout with the last known state, and never replays the navigation", async () => {
    vi.useFakeTimers();
    const h = install([tab({ id: 1, url: "https://a.test/old" })]);
    h.chrome.tabs.get.mockImplementation(async () => ({ ...h.tabs[0], status: "loading", url: "https://a.test/slow" }));
    const pending = navigateCommand({ tabId: 1, url: "https://a.test/slow" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(9000);
    const error = await pending;
    expect(codeOf(error)).toBe("timeout");
    expect((error as CommandError).payload.detail).toMatchObject({ tabId: 1, status: "loading", url: "https://a.test/slow" });
    expect(h.chrome.tabs.update).toHaveBeenCalledTimes(1);
  });
});

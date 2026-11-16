/**
 * `tabs.group` and a `groupId` the caller named.
 *
 * A caller that names a group is asking to join *that* group. The old code treated a
 * refusal as "the group we knew about has gone" and silently created a fresh one,
 * answering `ok` for a group the caller never named — a confident success that is a
 * different outcome, which an agent cannot detect or retry.
 *
 * The fix splits the two cases: a caller's id is honoured or refused (`not_found`),
 * while the marker's own remembered id may still recover by creating a group, because
 * that is the agent's bookkeeping going stale and there is no caller to mislead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupCommand } from "../../extension/src/lib/tab-ops.js";
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

function install(tabs: FakeTab[]): { chrome: any; groups: Map<number, any>; tabs: FakeTab[] } {
  const groups = new Map<number, any>();
  let nextGroupId = 99;
  const chrome = {
    tabs: {
      query: vi.fn(async () => tabs.map((t) => ({ ...t }))),
      get: vi.fn(async (id: number) => {
        const found = tabs.find((t) => t.id === id);
        if (!found) throw new Error(`No tab with id: ${id}.`);
        return { ...found };
      }),
      group: vi.fn(async (opts: any) => {
        // Chrome refuses an id it does not know, exactly as the real API does.
        let groupId = opts.groupId;
        if (groupId === undefined) {
          groupId = nextGroupId++;
          groups.set(groupId, { id: groupId, color: "grey", title: "", collapsed: true });
        } else if (!groups.has(groupId)) {
          throw new Error(`No group with id: ${groupId}`);
        }
        for (const id of opts.tabIds) {
          const found = tabs.find((t) => t.id === id);
          if (found) found.groupId = groupId;
        }
        return groupId;
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
  };
  (globalThis as any).chrome = chrome;
  return { chrome, groups, tabs };
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(CommandError);
  return (error as CommandError).payload.code;
}

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe("a caller-named groupId is honoured or refused, never substituted", () => {
  it("groups into an explicit group that exists", async () => {
    const h = install([tab({ id: 1 })]);
    h.groups.set(3, { id: 3, color: "grey", title: "mine", collapsed: false });

    const result = (await groupCommand({ tabIds: [1], groupId: 3 })) as { groupId: number };

    expect(result.groupId).toBe(3);
    expect(h.chrome.tabs.group).toHaveBeenCalledTimes(1);
    expect(h.chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1], groupId: 3 });
  });

  it("is not_found when the named group does not exist, and creates nothing", async () => {
    const h = install([tab({ id: 1 })]);

    const error = await groupCommand({ tabIds: [1], groupId: 12345 }).catch((e) => e);

    expect(codeOf(error)).toBe("not_found");
    // The whole point: exactly one attempt, no second call that would have made a
    // group the caller never named.
    expect(h.chrome.tabs.group).toHaveBeenCalledTimes(1);
    expect(h.groups.size).toBe(0);
  });

  it("does not silently move the tab when the named group is missing", async () => {
    const h = install([tab({ id: 1, groupId: -1 })]);

    await groupCommand({ tabIds: [1], groupId: 12345 }).catch(() => undefined);

    // The tab stayed ungrouped rather than landing in a group it never asked for.
    expect(h.tabs[0]!.groupId).toBe(-1);
    expect(h.groups.size).toBe(0);
  });

  it("refuses a groupId far outside any real id without inventing one", async () => {
    const h = install([tab({ id: 1 })]);

    const error = await groupCommand({ tabIds: [1], groupId: Number.MAX_SAFE_INTEGER }).catch((e) => e);

    expect(codeOf(error)).toBe("not_found");
    expect(h.chrome.tabs.group).toHaveBeenCalledTimes(1);
  });
});

describe("the marker's remembered group may still recover", () => {
  it("falls back exactly once when the remembered id is dead", async () => {
    const h = install([tab({ id: 1 })]);

    const result = (await groupCommand({ tabIds: [1], rememberedGroupId: 999 })) as { groupId: number };

    expect(result.groupId).toBe(99);
    expect(h.chrome.tabs.group).toHaveBeenCalledTimes(2);
    expect(h.chrome.tabs.group.mock.calls[1]![0]).toEqual({ tabIds: [1] });
  });

  it("reuses the remembered group when it is still there", async () => {
    const h = install([tab({ id: 1 })]);
    h.groups.set(7, { id: 7, color: "blue", title: "mine", collapsed: true });

    const result = (await groupCommand({ tabIds: [1], rememberedGroupId: 7 })) as { groupId: number };

    expect(result.groupId).toBe(7);
    expect(h.chrome.tabs.group).toHaveBeenCalledTimes(1);
    // The marker always re-asserts its own colour and title.
    expect(h.groups.get(7)).toMatchObject({ color: "red", title: "Ava", collapsed: false });
  });

  it("creates a group when there is no remembered id", async () => {
    const h = install([tab({ id: 1 })]);

    const result = (await groupCommand({ tabIds: [1] })) as { groupId: number };

    expect(result.groupId).toBe(99);
    expect(h.chrome.tabs.group).toHaveBeenCalledTimes(1);
  });
});

describe("a caller-named id wins over a remembered one", () => {
  it("tries only the caller's id, even if a dead remembered id is also given", async () => {
    const h = install([tab({ id: 1 })]);

    const error = await groupCommand({ tabIds: [1], groupId: 12345, rememberedGroupId: 999 }).catch((e) => e);

    expect(codeOf(error)).toBe("not_found");
    expect(h.chrome.tabs.group).toHaveBeenCalledTimes(1);
    expect(h.chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1], groupId: 12345 });
  });
});

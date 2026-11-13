/**
 * `tabs.create` (#23).
 *
 * The method exists so a flow that needs a page the user has not already opened does
 * not have to leave the bridge for AppleScript, which raises Chrome. The tests below
 * pin the two things that make it worth having: it never focuses the tab by default,
 * and it reports a tab only once the page has actually loaded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommand } from "../../extension/src/lib/tab-ops.js";
import { parseCreateParams } from "@gb-ava/protocol";
import { CommandError } from "../../extension/src/lib/errors.js";

interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  url: string;
  title: string;
  status: string;
  pinned?: boolean;
  groupId: number;
}

function tab(over: Partial<FakeTab> = {}): FakeTab {
  return {
    id: 1,
    windowId: 10,
    index: 0,
    active: false,
    url: "about:blank",
    title: "",
    status: "complete",
    groupId: -1,
    ...over,
  };
}

function install(options: { loadTo?: string; stayLoading?: boolean; noId?: boolean } = {}): {
  chrome: any;
  tabs: FakeTab[];
  created: any[];
} {
  const tabs: FakeTab[] = [];
  const created: any[] = [];
  let nextId = 100;
  const chrome = {
    tabs: {
      create: vi.fn(async (props: any) => {
        created.push(props);
        if (options.noId) return {};
        const id = nextId++;
        const landed = options.loadTo ?? props.url;
        const createdTab = tab({
          id,
          windowId: props.windowId ?? 10,
          url: landed,
          title: "Loaded",
          status: options.stayLoading ? "loading" : "complete",
          active: props.active ?? true,
          pinned: props.pinned,
        });
        tabs.push(createdTab);
        return { ...createdTab };
      }),
      get: vi.fn(async (id: number) => {
        const found = tabs.find((t) => t.id === id);
        if (!found) throw new Error(`No tab with id: ${id}.`);
        return { ...found };
      }),
      query: vi.fn(async () => tabs.map((t) => ({ ...t }))),
    },
    tabGroups: { update: vi.fn(async () => undefined), get: vi.fn(async () => undefined) },
    windows: { update: vi.fn(async () => undefined), get: vi.fn(async () => ({ id: 10 })) },
  };
  (globalThis as any).chrome = chrome;
  return { chrome, tabs, created };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).chrome;
  delete (globalThis as any).chrome;
});

describe("tabs.create opens a tab in the background by default", () => {
  it("passes active:false when background is not specified", async () => {
    const h = install();
    await createCommand({ url: "https://example.com/" });
    expect(h.created[0]).toMatchObject({ url: "https://example.com/", active: false });
  });

  it("passes active:false when background is explicitly true", async () => {
    const h = install();
    await createCommand({ url: "https://example.com/", background: true });
    expect(h.created[0]!.active).toBe(false);
  });

  it("focuses only when the caller asks for it", async () => {
    const h = install();
    await createCommand({ url: "https://example.com/", background: false });
    expect(h.created[0]!.active).toBe(true);
  });

  it("never touches the window, so nothing is raised", async () => {
    const h = install();
    await createCommand({ url: "https://example.com/" });
    // Chrome raising a window would show up as a focusing windows.update call.
    expect(h.chrome.windows.update).not.toHaveBeenCalled();
  });

  it("honours windowId and pinned", async () => {
    const h = install();
    await createCommand({ url: "https://example.com/", windowId: 42, pinned: true });
    expect(h.created[0]).toMatchObject({ windowId: 42, pinned: true });
  });
});

describe("tabs.create answers with a landed tab", () => {
  it("returns the tab descriptor once complete", async () => {
    const h = install({ loadTo: "https://example.com/" });
    const result = (await createCommand({ url: "https://example.com/" })) as Record<string, unknown>;
    expect(result).toMatchObject({ tabId: 100, url: "https://example.com/", title: "Loaded", status: "complete" });
    expect(h.tabs[0]!.id).toBe(100);
  });

  it("accepts a redirect as landing, once the tab has been seen loading", async () => {
    // A redirect is only evidence of *this* navigation if the tab was observed
    // loading: otherwise an old, complete tab at some other URL would look landed.
    const h = install({ loadTo: "https://example.com/final" });
    let polls = 0;
    const landed = await h.chrome.tabs.get(100).catch(() => null); // ensure the tab exists
    void landed;
    h.chrome.tabs.get.mockImplementation(async (id: number) => {
      polls += 1;
      const current = h.tabs.find((t) => t.id === id)!;
      // The first two observations report loading; afterwards the redirect target is
      // complete. This is what a real redirect looks like to the poll loop.
      return { ...current, status: polls <= 2 ? "loading" : "complete" };
    });

    const result = (await createCommand({ url: "https://example.com/" })) as Record<string, unknown>;
    // The requested URL is never seen: the loop settles on the redirect because it
    // saw the tab loading and then complete somewhere else.
    expect(result["url"]).toBe("https://example.com/final");
    expect(result["status"]).toBe("complete");
  });

  it("does not mistake an instantly-complete foreign tab for a landing", async () => {
    // Without ever observing `loading`, a complete tab at another URL is not proof
    // that this navigation landed. The same guard navigate relies on.
    vi.useFakeTimers();
    const h = install({ loadTo: "https://example.com/final" });
    const pending = createCommand({ url: "https://example.com/" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(9000);
    const error = await pending;
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).payload.code).toBe("timeout");
    expect(h.chrome.tabs.create).toHaveBeenCalled();
  });

  it("refuses a URL a page cannot be, before creating anything", async () => {
    const h = install();
    const error = await createCommand({ url: "javascript:alert(1)" }).catch((e) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).payload.code).toBe("invalid_request");
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("reports an internal error when Chrome returns a tab with no id", async () => {
    install({ noId: true });
    const error = await createCommand({ url: "https://example.com/" }).catch((e) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).payload.code).toBe("internal");
  });
});

describe("tabs.create parameters", () => {
  it("needs a url", () => {
    expect(parseCreateParams(undefined).ok).toBe(false);
    expect(parseCreateParams({}).ok).toBe(false);
  });

  it("accepts the documented keys", () => {
    const parsed = parseCreateParams({ url: "https://example.com/", windowId: 3, background: false, pinned: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ url: "https://example.com/", windowId: 3, background: false, pinned: true });
    }
  });

  it("refuses an unknown key", () => {
    expect(parseCreateParams({ url: "https://example.com/", active: true }).ok).toBe(false);
  });

  it("refuses a non-boolean background", () => {
    expect(parseCreateParams({ url: "https://example.com/", background: "yes" }).ok).toBe(false);
  });

  it("refuses a scheme a page cannot be", () => {
    expect(parseCreateParams({ url: "chrome://settings" }).ok).toBe(false);
    expect(parseCreateParams({ url: "javascript:alert(1)" }).ok).toBe(false);
  });
});

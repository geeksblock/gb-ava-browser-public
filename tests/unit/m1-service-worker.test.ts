/**
 * The service worker's command dispatch, driven through its real message path
 * (a bridge frame in, a reply frame out) against a stand-in Chrome.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeHandshake, startWorker, settle, type Harness } from "./support/chrome-harness.js";
import { EXTENSION_METHODS, V1_METHODS } from "@gb-ava/protocol";

let worker: Harness | null = null;

afterEach(() => {
  worker = null;
  delete (globalThis as any).chrome;
  delete (globalThis as any).WebSocket;
});

const boot = async (tabs?: any[]) => {
  worker = await startWorker(tabs);
  return worker;
};

describe("the dispatch table", () => {
  it("answers every advertised method, and never with unknown_method", async () => {
    const h = await boot();
    const params: Record<string, Record<string, unknown>> = {
      "page.readAX": { tabId: 1 },
      "page.getText": { tabId: 1 },
      "page.screenshot": { tabId: 1 },
      "page.click": { tabId: 1, selector: "#x" },
      "page.type": { tabId: 1, selector: "#x", text: "hi" },
      "page.key": { tabId: 1, key: "Enter" },
      "page.scroll": { tabId: 1 },
      "page.select": { tabId: 1, selector: "select", value: "a" },
      "page.upload": { tabId: 1, selector: "input", files: ["/tmp/x"] },
      "page.download": { tabId: 1 },
      "page.waitFor": { tabId: 1, timeoutMs: 1 },
      "page.evaluate": { tabId: 1, expression: "1" },
    };
    const unhandled: string[] = [];
    for (const method of EXTENSION_METHODS) {
      const reply = await h.call(method, params[method] ?? {});
      if (reply.error?.code === "unknown_method") unhandled.push(method);
    }
    expect(unhandled).toEqual([]);
  });

  it("refuses a method outside v1 with unknown_method, not a silent success", async () => {
    const h = await boot();
    const reply = await h.call("tabs.magic", {});
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe("unknown_method");
  });

  it("has no v1 method that is reserved but unbuilt", async () => {
    const h = await boot();
    const unbuilt: string[] = [];
    for (const method of V1_METHODS) {
      const reply = await h.call(method, {});
      if (reply.error?.code === "not_implemented") unbuilt.push(method);
    }
    expect(unbuilt).toEqual([]);
  });

  it("refuses a mistyped parameter key instead of ignoring it", async () => {
    const h = await boot();
    const reply = await h.call("tabs.close", { tabid: 1 });
    expect(reply.error?.code).toBe("invalid_request");
    expect(h.chrome.tabs.remove).not.toHaveBeenCalled();
  });
});

describe("session.start", () => {
  it("a second start that names no tabs does not silently release the marked tabs", async () => {
    // The docblock says a new session naming *different* tabs releases the old
    // set. This one names none — a caller restarting its session, or a retried
    // start — and the marker's tabs are ungrouped behind its back.
    const h = await boot();
    const first = await h.call("session.start", { tabIds: [1, 2] });
    expect(first.result.marker.tabIds).toEqual([1, 2]);

    const second = await h.call("session.start", {});
    expect(second.ok).toBe(true);
    expect(second.result.marker.tabIds).toEqual([1, 2]);
  });

  it("a restart while a group exists reuses it", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1, 2] });
    const before = h.chrome.tabs.group.mock.calls.length;
    await h.call("session.start", {});
    // Reusing the group is a no-op for chrome.tabs.group: the tab set did not
    // change, so the second start neither repaints nor creates a second group.
    expect(h.chrome.tabs.group.mock.calls.length).toBe(before);
    expect([...h.groups]).toEqual([7]);
  });
});

describe("tabs.group", () => {
  it("a failed paint is not reported as a marked tab", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1] });
    h.chrome.tabs.group.mockImplementation(async (options: any) => {
      if (options.tabIds.includes(2)) throw new Error("Tabs can only be moved to and from normal windows.");
      for (const id of options.tabIds) {
        const tab = h.tabs.find((candidate) => candidate.id === id);
        if (tab) tab.groupId = 7;
      }
      return 7;
    });
    const reply = await h.call("tabs.group", { tabIds: [2] });
    const marked = (reply.result?.marker?.tabIds ?? []) as number[];
    const painted = h.tabs.filter((tab) => tab.groupId !== -1).map((tab) => tab.id);
    expect(marked).not.toContain(2);
    expect(marked.every((id) => painted.includes(id))).toBe(true);
  });

  it("a failed paint is an error once nothing was painted at all", async () => {
    const h = await boot();
    h.chrome.tabs.group.mockRejectedValue(new Error("Tabs can only be moved to and from normal windows."));
    const reply = await h.call("tabs.group", { tabIds: [1] });
    expect(reply.ok).toBe(false);
  });
});

describe("session.status", () => {
  it("reports a group the human dissolved by hand as absent, and forgets it", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1, 2] });
    h.groups.delete(7);
    const reply = await h.call("session.status", {});
    expect(reply.result.marker.group).toBeNull();
  });

  it("does not report a dissolved group as still scheduled", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1, 2] });
    h.groups.delete(7);
    const reply = await h.call("session.status", {});
    // A group id Chrome no longer has must not keep being offered as current.
    expect(h.storage.markerState).toMatchObject({ groupId: null, grouped: false });
  });
});

describe("the marker after tabs.ungroup", () => {
  it("does not report a group it no longer has", async () => {
    const h = await boot();
    await h.call("tabs.group", { tabIds: [1] });
    h.groups.delete(7);
    const reply = await h.call("tabs.ungroup", { tabIds: [1] });
    expect(reply.result.marker.group).toBeNull();
  });
});

describe("session.end", () => {
  it("reports the real colour and title, not the promise, when no group is left", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1, 2] });
    const reply = await h.call("session.end", {});
    expect(reply.ok).toBe(true);
    expect(reply.result.marker.group).toBeNull();
    // `group` is null: there is no Chrome group, so there is no colour and no title.
    expect(reply.result.marker.color).toBeNull();
    expect(reply.result.marker.title).toBeNull();
  });

  it("a failed ungroup is an error, not a silent success", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1, 2] });
    h.chrome.tabs.ungroup.mockRejectedValueOnce(new Error("Invalid value for argument 1. Array must contain at least 1"));
    const reply = await h.call("session.end", {});
    // `ungroupedTabIds` would name tabs that are still in the Ava group.
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe("internal");
    expect(h.tabs.filter((tab) => tab.groupId === 7).map((tab) => tab.id)).toEqual([1, 2]);
  });
});

describe("a tab that closes mid-session", () => {
  it("is pruned from the marker when Chrome reports it closed", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1, 2] });
    h.tabs.splice(h.tabs.findIndex((tab) => tab.id === 2), 1);
    h.events.onRemoved.emit(2, { windowId: 10, isWindowClosing: false });
    await settle(20);
    const status = await h.call("session.status", {});
    expect(status.result.drivenTabIds).toEqual([1]);
  });
});

describe("the grace alarm", () => {
  it("is armed when the socket closes and not re-armed while it is already running", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1] });
    h.socket.fire("close", { code: 1006, reason: "gone" });
    await settle(20);
    expect(h.alarms.get("ava.ungroup-marker")).toMatchObject({ delayInMinutes: 1 });
    const created = h.chrome.alarms.create.mock.calls.filter((call: any[]) => call[0] === "ava.ungroup-marker").length;
    h.socket.fire("close", { code: 1006, reason: "gone again" });
    await settle(20);
    const createdAgain = h.chrome.alarms.create.mock.calls.filter((call: any[]) => call[0] === "ava.ungroup-marker").length;
    expect(createdAgain).toBe(created);
  });

  it("ungroups the marker when it expires with the bridge still away", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1, 2] });
    h.socket.fire("close", { code: 1006, reason: "gone" });
    await settle(20);
    h.alarms.delete("ava.ungroup-marker");
    h.events.onAlarm.emit({ name: "ava.ungroup-marker" });
    await settle(30);
    expect(h.tabs.map((tab) => tab.groupId)).toEqual([-1, -1]);
  });

  it("is cleared when the bridge comes back inside the window", async () => {
    const h = await boot();
    await h.call("session.start", { tabIds: [1] });
    const before = (globalThis as any).WebSocket.instances.length;
    h.socket.fire("close", { code: 1006, reason: "gone" });
    await settle(20);
    expect(h.alarms.has("ava.ungroup-marker")).toBe(true);
    // The worker's own backoff reconnects (first retry ~500 ms); the bridge "comes
    // back" only on that new socket, through the full handshake (ADR 0005).
    for (let waited = 0; waited < 3_000 && (globalThis as any).WebSocket.instances.length === before; waited += 25) {
      await settle(25);
    }
    const reconnected = (globalThis as any).WebSocket.instances.at(-1);
    expect(reconnected).not.toBe(h.socket);
    const { auth } = await completeHandshake(reconnected, { sessionId: "s2" });
    expect(auth, "the worker proved the token to the returning bridge").not.toBeNull();
    // The marker work after hello_ok is several awaits deep; wait for it, not a guess.
    for (let waited = 0; waited < 2_000 && h.alarms.has("ava.ungroup-marker"); waited += 10) await settle(10);
    expect(h.alarms.has("ava.ungroup-marker")).toBe(false);
    expect(h.tabs[0].groupId).toBe(7);
  });
});

it("uses a fake clock only where it must", () => {
  vi.useRealTimers();
});

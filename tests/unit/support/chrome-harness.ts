/**
 * A Chrome stand-in for the service-worker tests: only the APIs
 * extension/src/service-worker.ts calls, with tab / alarm / group state a test
 * can poke from outside and a `call()` that behaves like the bridge.
 */
import { vi } from "vitest";
import { PROOF_LABELS, makeProof, newNonce } from "@gb-ava/protocol";

type Listener = (...args: any[]) => any;

export interface FakeEvent {
  addListener: (fn: Listener) => void;
  removeListener: (fn: Listener) => void;
  hasListener: (fn: Listener) => boolean;
  emit: (...args: any[]) => void;
}

export function fakeEvent(): FakeEvent {
  const listeners: Listener[] = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    emit: (...args) => {
      for (const fn of [...listeners]) fn(...args);
    },
  };
}

export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.OPEN;
  readonly sent: any[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.fire("open", { type: "open" }));
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  fire(type: string, event: any): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

export const HARNESS_TOKEN = "test-token";

/**
 * Play the bridge's half of the v2 handshake on a fake socket (ADR 0005): read
 * the worker's hello, answer with a challenge proved with `token`, wait for the
 * worker's hello_auth, then send hello_ok. Returns what the worker sent.
 */
export async function completeHandshake(
  socket: FakeSocket,
  options: { token?: string; sessionId?: string } = {},
): Promise<{ hello: any; auth: any | null }> {
  const token = options.token ?? HARNESS_TOKEN;
  let hello: any = null;
  for (let waited = 0; waited < 2000 && hello === null; waited += 5) {
    hello = socket.sent.find((frame) => frame?.type === "hello") ?? null;
    if (hello === null) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (hello === null) throw new Error("the worker never sent hello");
  const serverNonce = newNonce();
  const serverProof = await makeProof(token, PROOF_LABELS.wsServer, [hello.clientNonce, serverNonce]);
  socket.fire("message", { data: JSON.stringify({ type: "hello_challenge", serverNonce, serverProof }) });
  let auth: any = null;
  for (let waited = 0; waited < 500 && auth === null; waited += 5) {
    auth = socket.sent.find((frame) => frame?.type === "hello_auth") ?? null;
    if (auth === null) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (auth !== null) {
    socket.fire("message", {
      data: JSON.stringify({ type: "hello_ok", protocolVersion: 2, sessionId: options.sessionId ?? "s1", server: { name: "fake", version: "0" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { hello, auth };
}

export interface Reply {
  id: string;
  ok: boolean;
  result?: any;
  error?: { code: string; message: string; retryable: boolean; detail?: any };
}

export interface Harness {
  storage: Record<string, unknown>;
  tabs: any[];
  alarms: Map<string, any>;
  /** group id -> the group chrome knows about */
  groups: Set<number>;
  socket: FakeSocket;
  events: { onRemoved: FakeEvent; onUpdated: FakeEvent; onAlarm: FakeEvent; onStorageChanged: FakeEvent; onMessage: FakeEvent };
  chrome: any;
  call: (method: string, params?: any) => Promise<Reply>;
  settle: (ms?: number) => Promise<void>;
}

export const DEFAULT_TABS = () => [
  { id: 1, windowId: 10, index: 0, active: true, pinned: false, url: "https://a.test/", title: "A", status: "complete", groupId: -1 },
  { id: 2, windowId: 10, index: 1, active: false, pinned: false, url: "https://b.test/", title: "B", status: "complete", groupId: -1 },
];

export async function startWorker(
  initialTabs: any[] = DEFAULT_TABS(),
  options: { skipHandshake?: boolean } = {},
): Promise<Harness> {
  FakeSocket.instances = [];
  const tabs = initialTabs.map((tab) => ({ ...tab }));
  const alarms = new Map<string, any>();
  const groups = new Set<number>([7]);
  const storage: Record<string, unknown> = { bridgeToken: HARNESS_TOKEN, bridgeUrl: "ws://127.0.0.1:8765" };
  let nextGroupId = 7;
  const events = {
    onRemoved: fakeEvent(),
    onUpdated: fakeEvent(),
    onAlarm: fakeEvent(),
    onStorageChanged: fakeEvent(),
    onMessage: fakeEvent(),
  };

  const chrome = {
    tabs: {
      query: vi.fn(async () => tabs.map((tab) => ({ ...tab }))),
      get: vi.fn(async (id: number) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return { ...tab };
      }),
      update: vi.fn(async (id: number, props: any) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        Object.assign(tab, props);
        return { ...tab };
      }),
      remove: vi.fn(async (id: number) => {
        const index = tabs.findIndex((candidate) => candidate.id === id);
        if (index < 0) throw new Error(`No tab with id: ${id}.`);
        tabs.splice(index, 1);
      }),
      group: vi.fn(async (options: any) => {
        const groupId = options.groupId ?? nextGroupId++;
        groups.add(groupId);
        for (const id of options.tabIds) {
          const tab = tabs.find((candidate) => candidate.id === id);
          if (tab) tab.groupId = groupId;
        }
        return groupId;
      }),
      ungroup: vi.fn(async (ids: number[]) => {
        for (const id of ids) {
          const tab = tabs.find((candidate) => candidate.id === id);
          if (tab) tab.groupId = -1;
        }
      }),
      onRemoved: events.onRemoved,
      onUpdated: events.onUpdated,
    },
    tabGroups: {
      get: vi.fn(async (id: number) => {
        if (!groups.has(id)) throw new Error(`No group with id: ${id}.`);
        return { id, color: "red", title: "Ava", collapsed: false };
      }),
      update: vi.fn(async (id: number) => {
        if (!groups.has(id)) throw new Error(`No group with id: ${id}.`);
        return { id, color: "red", title: "Ava", collapsed: false };
      }),
    },
    windows: {
      get: vi.fn(async (id: number) => ({ id, focused: false })),
      update: vi.fn(async (id: number) => ({ id, focused: false })),
    },
    alarms: {
      get: vi.fn(async (name: string) => alarms.get(name)),
      create: vi.fn(async (name: string, info: any) => {
        alarms.set(name, { name, ...info });
      }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      onAlarm: events.onAlarm,
    },
    runtime: {
      id: "test-extension",
      getURL: (path: string) => `chrome-extension://test-extension/${path.replace(/^\//, "")}`,
      getManifest: () => ({ version: "0.1.0" }),
      getContexts: vi.fn(async () => []),
      onInstalled: fakeEvent(),
      onStartup: fakeEvent(),
      onSuspend: fakeEvent(),
      onMessage: events.onMessage,
      openOptionsPage: vi.fn(),
    },
    offscreen: { createDocument: vi.fn(async () => undefined), Reason: { WORKERS: "WORKERS" } },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in storage) out[key] = storage[key];
          return out;
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          const changes: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: storage[key], newValue: value };
            storage[key] = value;
          }
          queueMicrotask(() => events.onStorageChanged.emit(changes, "local"));
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const key of keys) delete storage[key];
        }),
      },
      onChanged: events.onStorageChanged,
    },
    action: { onClicked: fakeEvent() },
  };

  (globalThis as any).chrome = chrome;
  (globalThis as any).WebSocket = FakeSocket;

  // Fresh module graph: the worker keeps its state in module-level variables.
  vi.resetModules();
  await import("../../../extension/src/service-worker.js");
  await settle(20);

  const socket = FakeSocket.instances[0];
  if (!socket) throw new Error("the worker never opened a socket");
  // The worker acts on nothing before the handshake completes, so the harness
  // plays the real bridge's half of it first.
  if (!options.skipHandshake) await completeHandshake(socket);
  let seq = 0;

  const harness: Harness = {
    storage,
    tabs,
    alarms,
    groups,
    socket,
    events,
    chrome,
    settle,
    call: async (method: string, params?: any) => {
      seq += 1;
      const id = `req-${seq}`;
      const before = socket.sent.length;
      socket.fire("message", {
        data: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
      });
      for (let waited = 0; waited < 8000; waited += 5) {
        const reply = socket.sent
          .slice(before)
          .find((frame) => frame?.id === id && (frame.ok !== undefined || frame.error !== undefined));
        if (reply) return reply as Reply;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`no reply to ${method}`);
    },
  };
  return harness;
}

export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

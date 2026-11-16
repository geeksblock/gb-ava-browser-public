/**
 * ADR 0005 — the security review's findings, each pinned by the behaviour that
 * closes it, on the extension side (the bridge side lives in bridge.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROOF_LABELS, makeProof, newNonce, sha256Hex } from "@gb-ava/protocol";
import { RPC_PROOF_LABELS, rpcProof } from "../../adapter/src/client.js";
import { completeHandshake, settle, startWorker, type Harness } from "./support/chrome-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function status(h: Harness, sender: { id?: string; url?: string }): Promise<any> {
  return new Promise((resolve) => {
    const listenerReturned = h.events.onMessage.emit({ type: "ava.status" }, sender, resolve);
    void listenerReturned;
    setTimeout(() => resolve(undefined), 200);
  });
}

const OPTIONS_SENDER = { id: "test-extension", url: "chrome-extension://test-extension/options.html" };

describe("the handshake never hands an impostor anything (finding 1)", () => {
  it("the hello carries a nonce and never the token", async () => {
    const h = await startWorker(undefined, { skipHandshake: true });
    await settle(20);
    const hello = h.socket.sent.find((frame) => frame?.type === "hello");
    expect(hello).toBeDefined();
    expect(hello.clientNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(h.socket.sent)).not.toContain("test-token");
  });

  it("a peer that cannot prove the token gets no proof back, and the worker blocks", async () => {
    const h = await startWorker(undefined, { skipHandshake: true });
    const { auth } = await completeHandshake(h.socket, { token: "an-impostor-does-not-know-the-token" });
    expect(auth).toBeNull();
    expect(JSON.stringify(h.socket.sent)).not.toContain("test-token");
    const view = await status(h, OPTIONS_SENDER);
    expect(view.supervisor.phase).toBe("blocked");
    expect(view.supervisor.blockedReason).toBe("bridge_unverified");
  });

  it("requests from a peer that has not completed the handshake are never answered", async () => {
    const h = await startWorker(undefined, { skipHandshake: true });
    h.socket.fire("message", { data: JSON.stringify({ id: "early", method: "tabs.list", params: {} }) });
    await settle(50);
    expect(h.socket.sent.some((frame) => frame?.id === "early")).toBe(false);
    expect(h.chrome.tabs.query).not.toHaveBeenCalled();
  });

  it("a hello_ok with no challenge first is treated as an impostor", async () => {
    const h = await startWorker(undefined, { skipHandshake: true });
    h.socket.fire("message", { data: JSON.stringify({ type: "hello_ok", protocolVersion: 2, sessionId: "fake" }) });
    await settle(30);
    h.socket.fire("message", { data: JSON.stringify({ id: "after", method: "tabs.list", params: {} }) });
    await settle(30);
    expect(h.socket.sent.some((frame) => frame?.id === "after")).toBe(false);
    expect((await status(h, OPTIONS_SENDER)).supervisor.blockedReason).toBe("bridge_unverified");
  });

  it("an unproven peer's 'wrong token' claim is reported as not verified", async () => {
    const h = await startWorker(undefined, { skipHandshake: true });
    h.socket.fire("message", {
      data: JSON.stringify({ type: "hello_error", error: { code: "unauthorized", message: "token rejected", retryable: false } }),
    });
    await settle(30);
    const view = await status(h, OPTIONS_SENDER);
    expect(view.supervisor.blockedReason).toBe("bridge_unverified");
    expect(String(view.health?.worker?.lastError ?? view.health?.lastError ?? "")).toMatch(/could not prove|refused before proving/);
  });

  it("a request in the frame right behind hello_ok is served, not dropped", async () => {
    const h = await startWorker(undefined, { skipHandshake: true });
    let hello: any = null;
    for (let waited = 0; waited < 1000 && hello === null; waited += 5) {
      hello = h.socket.sent.find((frame) => frame?.type === "hello") ?? null;
      if (hello === null) await settle(5);
    }
    const serverNonce = newNonce();
    const serverProof = await makeProof("test-token", PROOF_LABELS.wsServer, [hello.clientNonce, serverNonce]);
    h.socket.fire("message", { data: JSON.stringify({ type: "hello_challenge", serverNonce, serverProof }) });
    for (let waited = 0; waited < 500 && !h.socket.sent.some((f) => f?.type === "hello_auth"); waited += 5) await settle(5);
    // hello_ok and a request fired back to back, with no wait between them.
    h.socket.fire("message", { data: JSON.stringify({ type: "hello_ok", protocolVersion: 2, sessionId: "s1" }) });
    h.socket.fire("message", { data: JSON.stringify({ id: "right-behind", method: "tabs.list", params: {} }) });
    for (let waited = 0; waited < 2000 && !h.socket.sent.some((f) => f?.id === "right-behind"); waited += 10) await settle(10);
    expect(h.socket.sent.find((f) => f?.id === "right-behind")?.ok).toBe(true);
  });

  it("the real bridge still connects and is served", async () => {
    const h = await startWorker();
    const reply = await h.call("tabs.list", {});
    expect(reply.ok).toBe(true);
  });
});

describe("Ava never acts on browser, extension or file pages (finding 4)", () => {
  const PROTECTED = [
    { id: 1, windowId: 10, index: 0, active: true, pinned: false, url: "chrome-extension://test-extension/options.html", title: "Ava settings", status: "complete", groupId: -1 },
    { id: 2, windowId: 10, index: 1, active: false, pinned: false, url: "chrome://settings/", title: "Settings", status: "complete", groupId: -1 },
    { id: 3, windowId: 10, index: 2, active: false, pinned: false, url: "file:///Users/someone/.ssh/id_rsa", title: "id_rsa", status: "complete", groupId: -1 },
    { id: 4, windowId: 10, index: 3, active: false, pinned: false, url: "https://ok.example/", title: "OK", status: "complete", groupId: -1 },
  ];

  it("refuses page reads and actions on each protected tab, before touching the debugger", async () => {
    const h = await startWorker(PROTECTED);
    const attach = vi.fn(async () => undefined);
    h.chrome.debugger = { attach, detach: vi.fn(async () => undefined), sendCommand: vi.fn(async () => ({})), onEvent: { addListener() {} }, onDetach: { addListener() {} } };
    h.chrome.scripting = { executeScript: vi.fn(async () => [{ result: null }]) };
    for (const tabId of [1, 2, 3]) {
      for (const [method, params] of [
        ["page.getText", { tabId }],
        ["page.click", { tabId, selector: "#evaluate-enabled" }],
        ["page.key", { tabId, key: "Space" }],
      ] as const) {
        const reply = await h.call(method, params);
        expect(reply.ok, `${method} on tab ${tabId}`).toBe(false);
        expect(reply.error?.code).toBe("invalid_request");
        expect(reply.error?.message).toMatch(/does not read or act on those/);
      }
    }
    expect(attach).not.toHaveBeenCalled();
    expect(h.chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe("only the extension's own pages may change its settings (finding 4)", () => {
  it("ignores a settings message from any sender but the options page", async () => {
    const h = await startWorker();
    for (const sender of [
      {},
      { id: "another-extension", url: "chrome-extension://another-extension/options.html" },
      { id: "test-extension", url: "https://example.com/" },
      { id: "test-extension", url: "chrome-extension://test-extension/offscreen.html" },
    ]) {
      const answered = await new Promise((resolve) => {
        const keptOpen = h.events.onMessage.emit({ type: "ava.setEvaluate", enabled: true }, sender, resolve);
        void keptOpen;
        setTimeout(() => resolve("no answer"), 100);
      });
      expect(answered, JSON.stringify(sender)).toBe("no answer");
    }
    expect(h.storage["evaluateEnabled"]).not.toBe(true);
  });

  it("accepts it from the options page", async () => {
    const h = await startWorker();
    const answered: any = await new Promise((resolve) => {
      h.events.onMessage.emit({ type: "ava.setEvaluate", enabled: true }, OPTIONS_SENDER, resolve);
    });
    expect(answered.ok).toBe(true);
    expect(h.storage["evaluateEnabled"]).toBe(true);
  });
});

describe("the adapter's proofs match the shared implementation", () => {
  it("produces byte-identical rpc proofs for the same inputs", async () => {
    const token = "a".repeat(43);
    const nonce = newNonce();
    const digest = await sha256Hex('{"id":"1","method":"health"}');
    expect(rpcProof(token, RPC_PROOF_LABELS.client, [nonce, digest])).toBe(
      await makeProof(token, PROOF_LABELS.rpcClient, [nonce, digest]),
    );
    expect(rpcProof(token, RPC_PROOF_LABELS.server, [nonce, nonce])).toBe(
      await makeProof(token, PROOF_LABELS.rpcServer, [nonce, nonce]),
    );
    expect(rpcProof(token, RPC_PROOF_LABELS.response, [nonce, digest])).toBe(
      await makeProof(token, PROOF_LABELS.rpcResponse, [nonce, digest]),
    );
  });
});

describe("the adapter dials only the address the bridge binds", () => {
  it("refuses localhost and ::1, where an impostor could sit", async () => {
    const { BridgeClient } = await import("../../adapter/src/client.js");
    for (const host of ["localhost", "::1", "10.0.0.4"]) {
      expect(() => new BridgeClient({ host, token: "t".repeat(43) }), host).toThrow(/127\.0\.0\.1 only/);
    }
    expect(() => new BridgeClient({ host: "127.0.0.1", token: "t".repeat(43) })).not.toThrow();
  });
});

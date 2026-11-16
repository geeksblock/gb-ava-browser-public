/**
 * Build identity, and the stale-extension diagnosis built on it.
 *
 * The defect this file guards: a rebuilt unpacked extension can keep serving the
 * service-worker script Chrome cached at the extension's last load, even across a
 * browser restart. The symptom is `unknown_method` for a method that exists in
 * the repository, which reads exactly like a missing handler (the mistake in
 * an earlier report). Every side now carries a build stamp, the bridge compares them, and
 * an `unknown_method` from a stale extension is turned into a stated diagnosis.
 */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  BUILT_AT,
  BUILD_ID,
  MAX_BUILD_LABEL_LENGTH,
  PROTOCOL_VERSION,
  PROOF_LABELS,
  createLogger,
  isClientHello,
  isBuildLabel,
  makeProof,
  newNonce,
  provenRpc,
} from "@gb-ava/protocol";
import { startWorker, type Harness } from "./support/chrome-harness.js";
import { createBridge, type Bridge } from "../../bridge/src/server.js";
import { BridgeClient } from "../../adapter/src/client.js";
import { BridgeError } from "../../adapter/src/errors.js";
import { describeError } from "../../mcp/src/tools.js";

const TOKEN = "test-token-build-identity-0123456789";
const silent = createLogger({ scope: "test", sink: () => {}, level: "error" });

let worker: Harness | null = null;
const bridges: Bridge[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  worker = null;
  delete (globalThis as any).chrome;
  delete (globalThis as any).WebSocket;
  for (const socket of sockets.splice(0)) {
    try {
      socket.close();
    } catch {
      socket.terminate();
    }
  }
  for (const bridge of bridges.splice(0)) await bridge.stop();
});

/* ------------------------------------------------------------------ */
/* The stamp itself                                                    */
/* ------------------------------------------------------------------ */

describe("every bundle carries a build stamp", () => {
  it("has a usable id and timestamp (the vitest define supplies test values)", () => {
    expect(typeof BUILD_ID).toBe("string");
    expect(BUILD_ID.length).toBeGreaterThan(0);
    expect(BUILD_ID).toBe("test-build");
    expect(BUILT_AT).toBe("2026-01-01T00:00:00.000Z");
  });

  it("accepts a commit id as a build label and refuses garbage", () => {
    expect(isBuildLabel("4306f1f")).toBe(true);
    expect(isBuildLabel("4306f1f-dirty")).toBe(true);
    expect(isBuildLabel("")).toBe(false);
    expect(isBuildLabel("x".repeat(MAX_BUILD_LABEL_LENGTH + 1))).toBe(false);
    expect(isBuildLabel(42)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Handshake                                                           */
/* ------------------------------------------------------------------ */

const hello = (client: Record<string, unknown>) => ({
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  clientNonce: newNonce(),
  client: { name: "gb-ava-extension", version: "0.1.0", ...client },
});

describe("the hello carries the extension's build", () => {
  it("accepts a hello with a build stamp", () => {
    expect(isClientHello(hello({ build: "4306f1f", builtAt: "2026-11-06T16:43:22.000Z" }))).toBe(true);
  });

  it("accepts a hello from an extension that predates build stamping", () => {
    // Optional by design: refusing the handshake would turn "old build" into
    // "cannot drive the browser at all".
    expect(isClientHello(hello({}))).toBe(true);
  });

  it("refuses a malformed build stamp rather than quoting it in diagnostics later", () => {
    expect(isClientHello(hello({ build: 42 }))).toBe(false);
    expect(isClientHello(hello({ build: "" }))).toBe(false);
    expect(isClientHello(hello({ builtAt: ["x"] }))).toBe(false);
    expect(isClientHello(hello({ build: "x".repeat(MAX_BUILD_LABEL_LENGTH + 1) }))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The extension                                                       */
/* ------------------------------------------------------------------ */

describe("the extension reports its own build", () => {
  it("puts the stamp in its hello", async () => {
    worker = await startWorker();
    const sentHello = worker.socket.sent.find((frame) => frame?.type === "hello");
    expect(sentHello).toBeDefined();
    expect(sentHello.client.build).toBe(BUILD_ID);
    expect(sentHello.client.builtAt).toBe(BUILT_AT);
  });

  it("puts the stamp in its health payload", async () => {
    worker = await startWorker();
    const reply = await worker.call("health");
    expect(reply.ok).toBe(true);
    expect(reply.result.extension.build).toBe(BUILD_ID);
    expect(reply.result.extension.builtAt).toBe(BUILT_AT);
  });

  it("stamps an unknown_method so the caller can tell stale from missing", async () => {
    worker = await startWorker();
    const reply = await worker.call("tabs.magic");
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe("unknown_method");
    expect(reply.error?.detail).toMatchObject({ extensionBuild: BUILD_ID, extensionBuiltAt: BUILT_AT });
  });
});

/* ------------------------------------------------------------------ */
/* The bridge                                                          */
/* ------------------------------------------------------------------ */

interface FakeExtension {
  socket: WebSocket;
  received: Array<Record<string, unknown>>;
  sessionId: string;
}

/**
 * A fake extension that reports whatever build the test gives it. `onMethod` is
 * called for every command frame; the test decides the reply.
 */
function connectFake(
  port: number,
  options: {
    clientExtra?: Record<string, unknown>;
    onMethod?: (method: string, id: string, reply: (payload: unknown) => void) => void;
  } = {},
): Promise<FakeExtension> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    sockets.push(socket);
    const received: Array<Record<string, unknown>> = [];
    let settled = false;
    let sessionId = "";
    const done = (value: FakeExtension): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // The v2 handshake (ADR 0005): hello with a nonce, then answer the bridge's
    // challenge with a proof of the token.
    const first = hello(options.clientExtra ?? {});
    socket.on("open", () => {
      socket.send(JSON.stringify(first));
    });
    socket.on("message", (data) => {
      const parsed = JSON.parse(String(data)) as Record<string, unknown>;
      received.push(parsed);
      if (parsed["type"] === "hello_challenge") {
        void makeProof(TOKEN, PROOF_LABELS.wsClient, [first.clientNonce, String(parsed["serverNonce"])]).then((clientProof) =>
          socket.send(JSON.stringify({ type: "hello_auth", clientProof })),
        );
        return;
      }
      if (parsed["type"] === "hello_ok") {
        sessionId = String(parsed["sessionId"]);
        done({ socket, received, sessionId });
        return;
      }
      if (parsed["type"] === "hello_error") {
        done({ socket, received, sessionId });
        return;
      }
      if (typeof parsed["method"] === "string") {
        const method = String(parsed["method"]);
        const id = String(parsed["id"]);
        options.onMethod?.(method, id, (payload) => socket.send(JSON.stringify(payload)));
      }
    });
    socket.on("error", reject);
  });
}

async function startBridge(): Promise<{ bridge: Bridge; port: number }> {
  const bridge = createBridge({ port: 0, token: TOKEN, logger: silent, healthTimeoutMs: 500 });
  const address = await bridge.start();
  bridges.push(bridge);
  return { bridge, port: address.port };
}

async function rpc(port: number, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const result = await provenRpc({ host: "127.0.0.1", port, token: TOKEN, body: JSON.stringify(body), timeoutMs: 10_000 });
  return { status: result.status, json: (result.body ?? {}) as Record<string, unknown> };
}

const errorReply = (id: string, code: string, message: string, detail?: Record<string, unknown>) => ({
  id,
  ok: false,
  error: { code, message, retryable: false, ...(detail === undefined ? {} : { detail }) },
});

describe("/health compares both build identities", () => {
  it("reports the bridge's own build and the extension's, and flags a mismatch", async () => {
    const { bridge, port } = await startBridge();
    const fake = await connectFake(port, { clientExtra: { build: "older-build", builtAt: "2026-10-31T19:58:53.000Z" } });

    const health = await bridge.health();
    expect(health.build.bridge.id).toBe(BUILD_ID);
    expect(health.build.extension).toEqual({ id: "older-build", builtAt: "2026-10-31T19:58:53.000Z" });
    expect(health.build.mismatch).toBe(true);
    expect(health.extension.connected).toBe(true);
    if (health.extension.connected) expect(health.extension.sessionId).toBe(fake.sessionId);
  });

  it("reports no mismatch when the builds agree", async () => {
    const { bridge, port } = await startBridge();
    await connectFake(port, { clientExtra: { build: BUILD_ID, builtAt: BUILT_AT } });
    const health = await bridge.health();
    expect(health.build.mismatch).toBe(false);
  });

  it("cannot compare an extension that predates build stamping, and says so with null", async () => {
    const { bridge, port } = await startBridge();
    await connectFake(port);
    const health = await bridge.health();
    expect(health.build.extension).toBeNull();
    expect(health.build.mismatch).toBeNull();
  });

  it("publishes the build on /version for a diagnostic outside any tool", async () => {
    const { port } = await startBridge();
    const response = await fetch(`http://127.0.0.1:${port}/version`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.build).toBe(BUILD_ID);
    expect(body.builtAt).toBe(BUILT_AT);
  });
});

describe("an unknown_method from a stale extension is diagnosed, not echoed", () => {
  it("names both builds and says to reload the unpacked extension", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      clientExtra: { build: "older-build", builtAt: "2025-10-31T19:58:53.000Z" },
      onMethod: (method, id, reply) => {
        reply(errorReply(id, "unknown_method", `unknown method: ${method}`, {
          extensionBuild: "older-build",
          extensionBuiltAt: "2025-10-31T19:58:53.000Z",
        }));
      },
    });
    const { status, json } = await rpc(port, { id: "1", method: "tabs.create", params: { url: "about:blank" } });
    expect(status).toBe(200);
    const error = json.error as { code: string; message: string; detail: Record<string, unknown> };
    expect(error.code).toBe("unknown_method");
    expect(error.message).toContain("older-build");
    expect(error.message).toContain(BUILD_ID);
    expect(error.message).toMatch(/stale/i);
    expect(error.message).toMatch(/reload the unpacked extension/i);
    expect(error.message).toMatch(/Chrome restart does not refresh|chrome:\/\/extensions/i);
    expect(error.detail).toMatchObject({
      extensionBuild: "older-build",
      bridgeBuild: BUILD_ID,
    });
    expect(String(error.detail.hint)).toMatch(/reload the unpacked extension/i);
  });

  it("does not call a same-build unknown_method a stale build", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      clientExtra: { build: BUILD_ID, builtAt: BUILT_AT },
      onMethod: (method, id, reply) => {
        reply(errorReply(id, "unknown_method", `unknown method: ${method}`, { extensionBuild: BUILD_ID }));
      },
    });
    const { json } = await rpc(port, { id: "1", method: "tabs.create", params: {} });
    const error = json.error as { message: string; detail: Record<string, unknown> };
    expect(error.message).toMatch(/not a stale-build symptom/i);
    expect(String(error.detail.hint)).toMatch(/not a stale-build symptom/i);
  });

  it("tells the operator to reload an extension that reports no build at all", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      onMethod: (method, id, reply) => {
        reply(errorReply(id, "unknown_method", `unknown method: ${method}`));
      },
    });
    const { json } = await rpc(port, { id: "1", method: "tabs.create", params: {} });
    const error = json.error as { message: string; detail: Record<string, unknown> };
    expect(error.message).toMatch(/predates build stamping/i);
    expect(error.detail.bridgeBuild).toBe(BUILD_ID);
  });

  it("leaves every other error code untouched", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      clientExtra: { build: "older-build" },
      onMethod: (method, id, reply) => {
        reply(errorReply(id, "invalid_request", `tabs.navigate needs a url`, { field: "url" }));
      },
    });
    const { json } = await rpc(port, { id: "1", method: "tabs.navigate", params: {} });
    const error = json.error as { code: string; message: string; detail: Record<string, unknown> };
    expect(error.code).toBe("invalid_request");
    expect(error.message).toBe("tabs.navigate needs a url");
    expect(error.detail).toEqual({ field: "url" });
  });
});

/* ------------------------------------------------------------------ */
/* The tool surface an agent sees                                      */
/* ------------------------------------------------------------------ */

describe("the MCP tool surface carries the diagnosis to the model", () => {
  it("serialises the enriched unknown_method message and hint unchanged", () => {
    // What the adapter does with the bridge's answer: a BridgeError that keeps the
    // bridge's message and detail. The model must see the stale-build hint, not a
    // bare "unknown method".
    const error = new BridgeError(
      "unknown_method",
      "unknown method: tabs.create — the running extension was built older-build, this bridge test-build — the extension is stale: reload the unpacked extension at chrome://extensions",
      false,
      { hint: "the extension is stale: reload the unpacked extension", extensionBuild: "older-build", bridgeBuild: BUILD_ID },
    );
    const described = describeError(error);
    expect(described.needsHuman).toBe(false);
    const body = JSON.parse(described.text) as Record<string, unknown>;
    expect(body.error).toBe("unknown_method");
    expect(String(body.message)).toMatch(/stale/i);
    expect(String(body.message)).toMatch(/reload the unpacked extension/i);
    expect(body.detail).toMatchObject({ extensionBuild: "older-build", bridgeBuild: BUILD_ID });
  });
});

/* ------------------------------------------------------------------ */
/* Either side can be the stale one                                    */
/* ------------------------------------------------------------------ */

describe("the diagnosis names the older side and offers both cures", () => {
  it("says to restart the bridge when the bridge is the older side", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      // Later than the bridge's test build time (BUILT_AT, 2026-01-01), so the
      // long-lived bridge process is the stale side — the workflow the first
      // cut of this change blamed on the extension.
      clientExtra: { build: "newer-extension", builtAt: "2026-06-01T00:00:00.000Z" },
      onMethod: (method, id, reply) => {
        reply(
          errorReply(id, "unknown_method", `unknown method: ${method}`, {
            extensionBuild: "newer-extension",
            extensionBuiltAt: "2026-06-01T00:00:00.000Z",
          }),
        );
      },
    });
    const { json } = await rpc(port, { id: "1", method: "tabs.create", params: {} });
    const error = json.error as { message: string; detail: Record<string, unknown> };
    expect(error.detail.olderSide).toBe("bridge");
    expect(String(error.detail.hint)).toMatch(/restart the bridge/i);
    expect(String(error.detail.hint)).not.toMatch(/reload the unpacked extension at chrome:\/\/extensions/i);
    expect(String(error.message)).toContain("newer-extension");
    expect(String(error.message)).toContain(BUILD_ID);
  });

  it("says to reload the extension when the extension is the older side", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      clientExtra: { build: "older-build", builtAt: "2025-01-01T00:00:00.000Z" },
      onMethod: (method, id, reply) => {
        reply(
          errorReply(id, "unknown_method", `unknown method: ${method}`, {
            extensionBuild: "older-build",
            extensionBuiltAt: "2025-01-01T00:00:00.000Z",
          }),
        );
      },
    });
    const { json } = await rpc(port, { id: "1", method: "tabs.create", params: {} });
    const error = json.error as { message: string; detail: Record<string, unknown> };
    expect(error.detail.olderSide).toBe("extension");
    expect(String(error.detail.hint)).toMatch(/reload the unpacked extension/i);
    expect(String(error.detail.hint)).not.toMatch(/restart the bridge/i);
  });

  it("names both builds and both cures when the order cannot be established", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      // A build id but no timestamp: the hello fields are independently optional.
      clientExtra: { build: "older-build" },
      onMethod: (method, id, reply) => {
        reply(errorReply(id, "unknown_method", `unknown method: ${method}`, { extensionBuild: "older-build" }));
      },
    });
    const { json } = await rpc(port, { id: "1", method: "tabs.create", params: {} });
    const error = json.error as { message: string; detail: Record<string, unknown> };
    expect(error.detail.olderSide).toBeNull();
    expect(String(error.detail.hint)).toMatch(/reload the unpacked extension/i);
    expect(String(error.detail.hint)).toMatch(/restart the bridge/i);
  });

  it("diagnoses not_implemented as well, without calling it an unknown method", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      clientExtra: { build: "older-build", builtAt: "2025-01-01T00:00:00.000Z" },
      onMethod: (method, id, reply) => {
        reply(
          errorReply(id, "not_implemented", `${method} is reserved in protocol v1 but not built yet`, {
            extensionBuild: "older-build",
            extensionBuiltAt: "2025-01-01T00:00:00.000Z",
          }),
        );
      },
    });
    const { json } = await rpc(port, { id: "1", method: "page.readAX", params: { tabId: 1 } });
    const error = json.error as { code: string; message: string; detail: Record<string, unknown> };
    expect(error.code).toBe("not_implemented");
    expect(String(error.detail.hint)).toMatch(/stale/i);
    expect(String(error.message)).not.toMatch(/really is unknown/i);
  });

  it("does not call a same-build not_implemented stale", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      clientExtra: { build: BUILD_ID, builtAt: BUILT_AT },
      onMethod: (method, id, reply) => {
        reply(
          errorReply(id, "not_implemented", `${method} is reserved in protocol v1 but not built yet`, {
            extensionBuild: BUILD_ID,
          }),
        );
      },
    });
    const { json } = await rpc(port, { id: "1", method: "page.readAX", params: { tabId: 1 } });
    const error = json.error as { message: string; detail: Record<string, unknown> };
    expect(String(error.detail.hint)).toMatch(/reserved-but-unbuilt/i);
    expect(String(error.detail.hint)).toMatch(/not a stale-build symptom/i);
  });

  it("uses the hello stamp when the error carries no detail at all", async () => {
    // This is the path an old extension's bare unknown_method takes; the hello
    // is the only place the build can come from.
    const { port } = await startBridge();
    await connectFake(port, {
      clientExtra: { build: "hello-only-build", builtAt: "2025-01-01T00:00:00.000Z" },
      onMethod: (method, id, reply) => {
        reply(errorReply(id, "unknown_method", `unknown method: ${method}`));
      },
    });
    const { json } = await rpc(port, { id: "1", method: "tabs.create", params: {} });
    const error = json.error as { message: string; detail: Record<string, unknown> };
    expect(String(error.detail.hint)).toContain("hello-only-build");
    expect(error.detail.extensionBuild).toBe("hello-only-build");
    expect(error.detail.olderSide).toBe("extension");
  });

  it("keeps the hint intact when the original message is at the length limit", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      clientExtra: { build: "older-build", builtAt: "2025-01-01T00:00:00.000Z" },
      onMethod: (method, id, reply) => {
        reply(
          errorReply(id, "unknown_method", `${"x".repeat(1_990)}${method}`, {
            extensionBuild: "older-build",
            extensionBuiltAt: "2025-01-01T00:00:00.000Z",
          }),
        );
      },
    });
    const { json } = await rpc(port, { id: "1", method: "tabs.create", params: {} });
    const error = json.error as { message: string; detail: Record<string, unknown> };
    expect(error.message.length).toBeLessThanOrEqual(2_000);
    expect(error.message.endsWith(String(error.detail.hint))).toBe(true);
    expect(String(error.detail.hint)).toMatch(/reload the unpacked extension/i);
  });
});

/* ------------------------------------------------------------------ */
/* The bridge's own rejections carry evidence too                      */
/* ------------------------------------------------------------------ */

describe("a stale bridge is diagnosable from its own rejection", () => {
  it("stamps a method outside protocol v1 with the bridge build and a restart hint", async () => {
    const { port } = await startBridge();
    const { status, json } = await rpc(port, { id: "1", method: "tabs.magic", params: {} });
    expect(status).toBe(400);
    const error = json.error as { code: string; detail: Record<string, unknown> };
    expect(error.code).toBe("unknown_method");
    expect(error.detail.bridgeBuild).toBe(BUILD_ID);
    expect(String(error.detail.hint)).toMatch(/restart the bridge/i);
  });
});

/* ------------------------------------------------------------------ */
/* The adapter preserves the diagnosis                                 */
/* ------------------------------------------------------------------ */

describe("a real BridgeClient surfaces the bridge's diagnosis", () => {
  it("keeps the enriched message and detail on the BridgeError", async () => {
    const { port } = await startBridge();
    await connectFake(port, {
      clientExtra: { build: "older-build", builtAt: "2025-01-01T00:00:00.000Z" },
      onMethod: (method, id, reply) => {
        reply(
          errorReply(id, "unknown_method", `unknown method: ${method}`, {
            extensionBuild: "older-build",
            extensionBuiltAt: "2025-01-01T00:00:00.000Z",
          }),
        );
      },
    });
    const client = new BridgeClient({ port, token: TOKEN });
    const error: unknown = await client.call("tabs.create", { url: "about:blank" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    const bridgeError = error as BridgeError;
    expect(bridgeError.code).toBe("unknown_method");
    expect(bridgeError.message).toMatch(/stale/i);
    expect(bridgeError.detail.hint).toMatch(/reload the unpacked extension/i);
    expect(bridgeError.detail.extensionBuild).toBe("older-build");
  });
});

/* ------------------------------------------------------------------ */
/* Handshake warning                                                   */
/* ------------------------------------------------------------------ */

describe("the bridge warns at handshake when the builds differ", () => {
  it("logs one warning naming both builds and the older side", async () => {
    const records: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const recording = createLogger({
      scope: "test",
      level: "warn",
      sink: (record) => {
        records.push(record as never);
      },
    });
    const bridge = createBridge({ port: 0, token: TOKEN, logger: recording });
    bridges.push(bridge);
    const address = await bridge.start();
    await connectFake(address.port, { clientExtra: { build: "older-build", builtAt: "2025-01-01T00:00:00.000Z" } });

    const warning = records.find((record) => record.message.includes("build differs"));
    expect(warning).toBeDefined();
    expect(warning?.level).toBe("warn");
    expect(warning?.fields).toMatchObject({
      extensionBuild: "older-build",
      bridgeBuild: BUILD_ID,
      olderSide: "extension",
    });
  });

  it("stays quiet when the builds agree", async () => {
    const records: Array<{ message: string }> = [];
    const recording = createLogger({ scope: "test", level: "warn", sink: (record) => records.push(record as never) });
    const bridge = createBridge({ port: 0, token: TOKEN, logger: recording });
    bridges.push(bridge);
    const address = await bridge.start();
    await connectFake(address.port, { clientExtra: { build: BUILD_ID, builtAt: BUILT_AT } });
    expect(records.some((record) => record.message.includes("build differs"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Health edge cases                                                   */
/* ------------------------------------------------------------------ */

describe("health build block edge cases", () => {
  it("reports the bridge's build and nulls when nothing is connected", async () => {
    const { bridge } = await startBridge();
    const health = await bridge.health();
    expect(health.build.bridge.id).toBe(BUILD_ID);
    expect(health.build.extension).toBeNull();
    expect(health.build.mismatch).toBeNull();
  });

  it("reports a build id without a timestamp as null rather than a magic string", async () => {
    const { bridge, port } = await startBridge();
    await connectFake(port, { clientExtra: { build: "older-build" } });
    const health = await bridge.health();
    expect(health.build.extension).toEqual({ id: "older-build", builtAt: null });
    expect(health.build.mismatch).toBe(true);
  });
});

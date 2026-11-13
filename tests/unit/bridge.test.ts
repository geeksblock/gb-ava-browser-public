import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, WS_CLOSE, createLogger, makeError, okResponse, type JsonObject } from "@gb-ava/protocol";
import { createBridge, isAllowedOrigin, isLoopbackAddress, type Bridge } from "../../bridge/src/server.js";

const TOKEN = "test-token-0123456789-abcdefghijklmnop";
const silent = createLogger({ scope: "test", sink: () => {}, level: "error" });

const bridges: Bridge[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.close();
    } catch {
      socket.terminate();
    }
  }
  for (const bridge of bridges.splice(0)) await bridge.stop();
});

async function startBridge(
  overrides: { allowedExtensionIds?: string[]; healthTimeoutMs?: number; requestTimeoutMs?: number } = {},
) {
  const bridge = createBridge({
    port: 0,
    token: TOKEN,
    logger: silent,
    allowedExtensionIds: overrides.allowedExtensionIds ?? [],
    healthTimeoutMs: overrides.healthTimeoutMs ?? 500,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 10_000,
  });
  const address = await bridge.start();
  bridges.push(bridge);
  return { bridge, port: address.port };
}

async function rpc(
  port: number,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** Stop the helper's default "reply ok" and answer every method with an error envelope. */
function answerWithError(fake: FakeExtension, code: string, message: string): void {
  fake.socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    if (typeof frame["method"] !== "string") return;
    fake.socket.send(
      JSON.stringify({ id: frame["id"], ok: false, error: makeError(code as never, message) }),
    );
  });
}

interface FakeExtension {
  socket: WebSocket;
  received: Array<Record<string, unknown>>;
  sessionId: string;
  closed: Promise<number>;
}

function connectFake(
  port: number,
  options: { token?: string; origin?: string; onRequest?: (method: string, reply: (result: unknown) => void) => void } = {},
): Promise<FakeExtension> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.origin !== undefined) headers["origin"] = options.origin;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers });
    sockets.push(socket);
    const received: Array<Record<string, unknown>> = [];
    let settled = false;
    let sessionId = "";
    const closed = new Promise<number>((closeResolve) => {
      socket.on("close", (code) => closeResolve(code));
    });

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token: options.token ?? TOKEN,
          client: { name: "fake-extension", version: "0.0.0-test" },
        }),
      );
    });

    socket.on("message", (data) => {
      const parsed = JSON.parse(String(data)) as Record<string, unknown>;
      received.push(parsed);
      if (parsed["type"] === "hello_ok") {
        sessionId = String(parsed["sessionId"]);
        if (!settled) {
          settled = true;
          resolve({ socket, received, sessionId, closed });
        }
        return;
      }
      if (parsed["type"] === "hello_error") {
        if (!settled) {
          settled = true;
          resolve({ socket, received, sessionId, closed });
        }
        return;
      }
      if (typeof parsed["method"] === "string") {
        const id = String(parsed["id"]);
        const method = String(parsed["method"]);
        if (options.onRequest) {
          options.onRequest(method, (result) => {
            socket.send(JSON.stringify(okResponse(id, result as never)));
          });
          return;
        }
        socket.send(JSON.stringify(okResponse(id, { method })));
      }
    });

    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

const fakeHealth = {
  worker: { phase: "connected", uptimeMs: 1234 },
  keepalive: { offscreenDocument: true, alarmScheduled: true, ticksReceived: 5 },
  session: { id: "sess" },
};

describe("origin and address policy", () => {
  it("accepts loopback addresses only", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.70.0.4")).toBe(false);
    expect(isLoopbackAddress("100.100.100.100")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("rejects a web page origin even when the port was guessed", () => {
    expect(isAllowedOrigin("https://example.com", [])).toBe(false);
    expect(isAllowedOrigin("https://evil.example.com:8443", [])).toBe(false);
    expect(isAllowedOrigin("null", [])).toBe(false);
  });

  it("accepts the extension origin, and only a configured id when an allowlist is set", () => {
    expect(isAllowedOrigin("chrome-extension://abcdefghijklmnop", [])).toBe(true);
    expect(isAllowedOrigin("chrome-extension://abcdefghijklmnop", ["abcdefghijklmnop"])).toBe(true);
    expect(isAllowedOrigin("chrome-extension://otherid", ["abcdefghijklmnop"])).toBe(false);
  });

  it("accepts a missing origin so local tools can connect", () => {
    expect(isAllowedOrigin(undefined, [])).toBe(true);
  });
});

describe("bridge handshake", () => {
  it("authenticates the extension and forwards health", async () => {
    const { bridge, port } = await startBridge();
    const fake = await connectFake(port, {
      onRequest: (_method, reply) => reply(fakeHealth),
    });
    expect(fake.sessionId).not.toBe("");

    const health = await bridge.health();
    expect(health.bridge.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(health.bridge.tokenConfigured).toBe(true);
    expect(health.extension.connected).toBe(true);
    if (health.extension.connected) {
      expect(health.extension.sessionId).toBe(fake.sessionId);
      expect(health.extension.health).toMatchObject({ worker: { phase: "connected" } });
    }
  });

  it("rejects a wrong token and reports why, without leaking either token", async () => {
    const { bridge, port } = await startBridge();
    const fake = await connectFake(port, { token: "wrong-token-wrong-token-wrong-token" });
    // connectFake resolves on hello_error, which is *before* the socket is closed.
    // The reason has to be recorded at the moment of rejection: reading /health in
    // this window used to answer `connected:false` with no reason, which is the
    // race that made this suite fail in CI while passing alone.
    const duringRejection = await bridge.health();
    expect(duringRejection.extension.connected).toBe(false);
    if (!duringRejection.extension.connected) {
      expect(duringRejection.extension.lastError?.code).toBe("unauthorized");
    }
    const closeCode = await fake.closed;
    expect(closeCode).toBe(WS_CLOSE.unauthorized);
    expect(JSON.stringify(fake.received)).not.toContain(TOKEN);
    const health = await bridge.health();
    expect(health.extension.connected).toBe(false);
    if (!health.extension.connected) {
      expect(health.extension.lastError?.code).toBe("unauthorized");
    }
  });

  it("refuses a non-extension origin at the HTTP upgrade", async () => {
    const { bridge, port } = await startBridge();
    await expect(connectFake(port, { origin: "https://example.com" })).rejects.toThrow(/403/);
    const health = await bridge.health();
    expect(health.extension.connected).toBe(false);
  });

  it("replaces an existing connection instead of interleaving two", async () => {
    const { bridge, port } = await startBridge();
    const first = await connectFake(port, { onRequest: (_m, reply) => reply(fakeHealth) });
    const second = await connectFake(port, { onRequest: (_m, reply) => reply(fakeHealth) });
    expect(await first.closed).toBe(WS_CLOSE.replaced);
    expect(bridge.currentSessionId()).toBe(second.sessionId);
  });
});

describe("bridge command semantics", () => {
  it("surfaces the extension's not_implemented for a reserved method", async () => {
    const { bridge, port } = await startBridge();
    const fake = await connectFake(port, { onRequest: () => {} });
    answerWithError(fake, "not_implemented", "page.readAX is reserved in protocol v1 but not built yet");
    await expect(bridge.requestExtension("page.readAX", undefined, 2_000)).rejects.toMatchObject({
      payload: { code: "not_implemented", retryable: false },
    });
  });

  it("fails in-flight commands loudly when the extension disappears", async () => {
    const { bridge, port } = await startBridge();
    const fake = await connectFake(port, {
      onRequest: () => {
        /* deliberately never replies */
      },
    });
    const inFlight = bridge.requestExtension("health", undefined, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.socket.close();
    await expect(inFlight).rejects.toThrow(/extension_disconnected/);
    const health = await bridge.health();
    expect(health.extension.connected).toBe(false);
  });

  it("times out a slow command and never replays it", async () => {
    const { bridge, port } = await startBridge();
    let seen = 0;
    await connectFake(port, {
      onRequest: (method) => {
        // Counts every method that reached the extension, and never answers.
        seen += 1;
        void method;
      },
    });
    const started = Date.now();
    await expect(bridge.requestExtension("slow.read", undefined, 150)).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen).toBe(1);
    // A replay would show up as a second arrival after the timeout fired.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seen).toBe(1);
  });

  it("rejects with extension_disconnected when nothing is connected", async () => {
    const { bridge } = await startBridge();
    await expect(bridge.requestExtension("health")).rejects.toThrow(/extension_disconnected/);
  });

  it("answers bridge-side requests from the extension, and rejects unknown ones", async () => {
    const { port } = await startBridge();
    const fake = await connectFake(port);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fake.socket.send(JSON.stringify({ id: "r1", method: "health" }));
    fake.socket.send(JSON.stringify({ id: "r2", method: "page.click" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const replies = fake.received.filter((frame) => typeof frame["ok"] === "boolean");
    const healthReply = replies.find((frame) => frame["id"] === "r1");
    const unknownReply = replies.find((frame) => frame["id"] === "r2");
    expect(healthReply).toMatchObject({ ok: true });
    expect(unknownReply).toMatchObject({ ok: false, error: { code: "unknown_method" } });
  });

  it("answers the HTTP health endpoint with the extension block", async () => {
    const { port } = await startBridge();
    await connectFake(port, { onRequest: (_m, reply) => reply(fakeHealth) });
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonObject;
    expect(body["ok"]).toBe(true);
    expect((body["extension"] as JsonObject)["connected"]).toBe(true);
  });

  it("404s an unknown HTTP route with the standard error shape", async () => {
    const { port } = await startBridge();
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_found");
  });

  it("binds loopback only, and reports the address it actually bound", async () => {
    const { bridge, port } = await startBridge();
    const health = await bridge.health();
    // The health payload carries the listener's own address, not the constant, so
    // a future 0.0.0.0 bind cannot pass this assertion.
    expect(health.bridge.host).toBe("127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/version`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { protocolVersion: number };
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe("bridge error shape", () => {
  it("uses the shared error taxonomy for its own failures", () => {
    const payload = makeError("extension_disconnected", "the extension is not connected");
    expect(payload.retryable).toBe(false);
  });
});

describe("the /rpc tool surface", () => {
  it("answers with extension_disconnected when nothing is connected", async () => {
    const { port } = await startBridge();
    const { status, json } = await rpc(port, { id: "r1", method: "health" });
    expect(status).toBe(200);
    expect(json["ok"]).toBe(false);
    expect((json["error"] as { code: string }).code).toBe("extension_disconnected");
  });

  it("reports a slow command as timeout, not as a disconnected extension", async () => {
    const { port } = await startBridge({ requestTimeoutMs: 150 });
    await connectFake(port, {
      onRequest: () => {
        /* deliberately never replies */
      },
    });
    const { status, json } = await rpc(port, { id: "r2", method: "health" });
    expect(status).toBe(200);
    const error = json["error"] as { code: string; retryable: boolean };
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(false);
  });

  it("forwarded commands keep the extension's own error payload", async () => {
    const { port } = await startBridge();
    // Supplying onRequest stops the helper's default "reply ok" so this test can
    // answer with a real error envelope instead.
    const fake = await connectFake(port, { onRequest: () => {} });
    const answered = new Promise<void>((resolve) => {
      fake.socket.on("message", (data) => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        if (typeof frame["method"] !== "string") return;
        fake.socket.send(
          JSON.stringify({
            id: frame["id"],
            ok: false,
            error: makeError("evaluate_disabled", "turn it on in the options page"),
          }),
        );
        resolve();
      });
    });
    const inFlight = rpc(port, { id: "r3", method: "settings.get" });
    await answered;
    const { status, json } = await inFlight;
    expect(status).toBe(200);
    expect((json["error"] as { code: string }).code).toBe("evaluate_disabled");
  });

  it("rejects a method outside v1 with 400 and never forwards it", async () => {
    const { port } = await startBridge();
    const { status, json } = await rpc(port, { id: "r4", method: "page.nope" });
    expect(status).toBe(400);
    expect((json["error"] as { code: string }).code).toBe("unknown_method");
  });

  it("answers one 413 for an oversized body and keeps serving", async () => {
    const { port } = await startBridge();
    const huge = { id: "big", method: "health", params: { pad: "a".repeat(300_000) } };
    const { status, json } = await rpc(port, huge);
    expect(status).toBe(413);
    expect((json["error"] as { code: string }).code).toBe("invalid_request");
    // The bridge must still be alive and must not have written a second response.
    const after = await rpc(port, { id: "after", method: "health" });
    expect(after.status).toBe(200);
    expect((after.json["error"] as { code: string }).code).toBe("extension_disconnected");
  });
});

describe("large replies", () => {
  it("carries a multi-megabyte result without dropping the socket", async () => {
    const { port } = await startBridge();
    // A screenshot is base64 and a big accessibility tree is large; a 1 MB frame
    // cap closed the socket with 1009 and the caller saw extension_disconnected.
    const big = "A".repeat(3_000_000);
    await connectFake(port, { onRequest: (_method, reply) => reply({ blob: big }) });
    const { status, json } = await rpc(port, { id: "big", method: "page.readAX" });
    expect(status).toBe(200);
    expect(json["ok"]).toBe(true);
    expect(((json["result"] as { blob: string }).blob ?? "").length).toBe(3_000_000);
    // The bridge is still usable afterwards.
    const after = await rpc(port, { id: "after-big", method: "health" });
    expect(after.status).toBe(200);
  });
});

describe("the http surface is authenticated", () => {
  it("refuses /rpc without the token", async () => {
    const { port } = await startBridge();
    const { status, json } = await rpc(port, { id: "n1", method: "health" }, {});
    expect(status).toBe(401);
    expect((json["error"] as { code: string }).code).toBe("unauthorized");
  });

  it("refuses /rpc with a wrong token", async () => {
    const { port } = await startBridge();
    const { status } = await rpc(port, { id: "n2", method: "health" }, { authorization: `Bearer ${"x".repeat(33)}` });
    expect(status).toBe(401);
  });

  it("accepts the token as a bearer header or as x-ava-token", async () => {
    const { port } = await startBridge();
    const bearer = await rpc(port, { id: "n3", method: "health" });
    expect(bearer.status).toBe(200);
    const header = await rpc(port, { id: "n4", method: "health" }, { "x-ava-token": TOKEN });
    expect(header.status).toBe(200);
  });

  it("refuses a page origin on both /rpc and /health", async () => {
    const { port } = await startBridge();
    const rpcResult = await rpc(
      port,
      { id: "n5", method: "health" },
      { authorization: `Bearer ${TOKEN}`, origin: "https://example.com" },
    );
    expect(rpcResult.status).toBe(403);
    const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: "https://example.com" } });
    expect(health.status).toBe(403);
  });

  it("leaves /health and /version readable without a token, for a human with curl", async () => {
    const { port } = await startBridge();
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    const version = await fetch(`http://127.0.0.1:${port}/version`);
    expect(version.status).toBe(200);
  });

  it("accepts the extension's own origin when an allowlist is configured", async () => {
    const { port } = await startBridge({ allowedExtensionIds: ["abcdefghijklmnop"] });
    const allowed = await rpc(
      port,
      { id: "n6", method: "health" },
      { authorization: `Bearer ${TOKEN}`, origin: "chrome-extension://abcdefghijklmnop" },
    );
    expect(allowed.status).toBe(200);
    const refused = await rpc(
      port,
      { id: "n7", method: "health" },
      { authorization: `Bearer ${TOKEN}`, origin: "chrome-extension://otherid" },
    );
    expect(refused.status).toBe(403);
  });
});

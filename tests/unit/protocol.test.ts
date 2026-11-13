import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  isV1Method,
  PROTOCOL_VERSION,
  RETRYABLE_BY_DEFAULT,
  WS_CLOSE,
  errorResponse,
  isClientHello,
  isControlFrame,
  isKnownMethod,
  isResponseEnvelope,
  isServerHello,
  makeError,
  okResponse,
  parseRequestEnvelope,
} from "@gb-ava/protocol";

describe("request envelope validation", () => {
  it("accepts a well-formed request", () => {
    const parsed = parseRequestEnvelope({ id: "1", method: "health" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ id: "1", method: "health" });
  });

  it("accepts params as an object", () => {
    const parsed = parseRequestEnvelope({ id: "abc", method: "health", params: { verbose: true } });
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["not an object", 42],
    ["missing id", { method: "health" }],
    ["empty id", { id: "", method: "health" }],
    ["missing method", { id: "1" }],
    ["empty method", { id: "1", method: "" }],
    ["params as array", { id: "1", method: "health", params: [] }],
    ["params as string", { id: "1", method: "health", params: "x" }],
    ["overlong id", { id: "x".repeat(129), method: "health" }],
  ])("rejects %s (fail closed, never a defaulted field)", (_label, input) => {
    const parsed = parseRequestEnvelope(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("invalid_request");
      expect(parsed.error.retryable).toBe(false);
    }
  });
});

describe("method registry", () => {
  it("knows health", () => {
    expect(isKnownMethod("health")).toBe(true);
  });

  it("rejects anything not implemented — an unknown method is never a no-op", () => {
    // A reserved name whose milestone has not landed is `not_implemented`, not a
    // silent success; a name outside v1 is `unknown_method`.
    expect(isKnownMethod("page.evaluate")).toBe(true);
    expect(isKnownMethod("tabs.move")).toBe(false);
    // #18: the tab that vanished mid-sequence is visible through these two.
    expect(isKnownMethod("tabs.activate")).toBe(true);
    expect(isKnownMethod("session.status")).toBe(true);
    expect(isKnownMethod("")).toBe(false);
    expect(isKnownMethod("HEALTH")).toBe(false);
    expect(isV1Method("tabs.move")).toBe(false);
    expect(isV1Method("page.evaluate")).toBe(true);
  });
});

describe("error taxonomy", () => {
  it("gives every code an explicit retryability default", () => {
    expect(Object.keys(RETRYABLE_BY_DEFAULT).sort()).toEqual([...ERROR_CODES].sort());
  });

  it("does not let an ambiguous outcome be retryable", () => {
    expect(RETRYABLE_BY_DEFAULT.timeout).toBe(false);
    expect(RETRYABLE_BY_DEFAULT.extension_disconnected).toBe(false);
    expect(RETRYABLE_BY_DEFAULT.tab_changed).toBe(false);
    expect(RETRYABLE_BY_DEFAULT.needs_human).toBe(false);
  });

  it("builds an error payload with the default retryability for its code", () => {
    const payload = makeError("unknown_method", "unknown method: page.click");
    expect(payload).toEqual({ code: "unknown_method", message: "unknown method: page.click", retryable: false });
  });

  it("truncates an overlong message rather than growing the frame", () => {
    const payload = makeError("internal", "x".repeat(4000));
    expect(payload.message.length).toBe(2000);
  });

  it("validates responses both ways", () => {
    expect(isResponseEnvelope(okResponse("1", { ok: true }))).toBe(true);
    expect(isResponseEnvelope(errorResponse("1", makeError("internal", "boom")))).toBe(true);
    expect(isResponseEnvelope({ id: "1", ok: true })).toBe(false);
    expect(isResponseEnvelope({ id: "1", ok: false, error: { code: "nope", message: "x", retryable: false } })).toBe(false);
  });
});

describe("handshake frames", () => {
  it("accepts a well-formed hello", () => {
    expect(
      isClientHello({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        token: "t",
        client: { name: "gb-ava-extension", version: "0.1.0" },
      }),
    ).toBe(true);
  });

  it("rejects a hello with no token — an empty token must not authenticate", () => {
    expect(isClientHello({ type: "hello", protocolVersion: 1, token: "", client: { name: "a", version: "1" } })).toBe(false);
  });

  it("recognises both hello replies", () => {
    expect(isServerHello({ type: "hello_ok", protocolVersion: 1, sessionId: "s" })).toBe(true);
    expect(isServerHello({ type: "hello_error", error: makeError("unauthorized", "no") })).toBe(true);
    expect(isServerHello({ type: "hello_maybe" })).toBe(false);
  });

  it("recognises control frames only with a numeric seq", () => {
    expect(isControlFrame({ type: "ping", seq: 1 })).toBe(true);
    expect(isControlFrame({ type: "pong", seq: "1" })).toBe(false);
    expect(isControlFrame({ type: "pong" })).toBe(false);
  });

  it("keeps the close codes in the application-private range", () => {
    for (const code of Object.values(WS_CLOSE)) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });
});

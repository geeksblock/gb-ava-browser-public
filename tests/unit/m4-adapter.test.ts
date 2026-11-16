import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError, NeedsHumanError, classifyStall, toAdapterError } from "../../adapter/src/errors.js";
import { BridgeClient, readToken } from "../../adapter/src/client.js";

describe("adapter error mapping", () => {
  it("turns needs_human into a typed error with its reason preserved", () => {
    const mapped = toAdapterError({
      code: "needs_human",
      message: "tab 3 is showing a JavaScript alert",
      retryable: false,
      detail: { reason: "javascript_dialog", tabId: 3 },
      tabId: 3,
    });
    expect(mapped).toBeInstanceOf(NeedsHumanError);
    expect((mapped as NeedsHumanError).reason).toBe("javascript_dialog");
    expect((mapped as NeedsHumanError).tabId).toBe(3);
  });

  it("says unknown rather than inventing a reason", () => {
    const mapped = toAdapterError({
      code: "needs_human",
      message: "something",
      retryable: false,
      detail: { reason: "coffee" },
    });
    expect(mapped).toBeInstanceOf(NeedsHumanError);
    expect((mapped as NeedsHumanError).reason).toBe("unknown");
  });

  it("keeps the tab from the detail when the error does not carry one", () => {
    const mapped = toAdapterError({
      code: "needs_human",
      message: "dialog",
      retryable: false,
      detail: { reason: "javascript_dialog", tabId: 42 },
    });
    expect((mapped as NeedsHumanError).tabId).toBe(42);
  });

  it("keeps every other code verbatim, with its retryability", () => {
    const mapped = toAdapterError({ code: "tab_busy", message: "busy", retryable: true });
    expect(mapped).toBeInstanceOf(BridgeError);
    expect(mapped).not.toBeInstanceOf(NeedsHumanError);
    expect((mapped as BridgeError).code).toBe("tab_busy");
    expect((mapped as BridgeError).retryable).toBe(true);
  });

  it("does not turn a plain timeout into a human problem", () => {
    const mapped = toAdapterError({ code: "timeout", message: "slow", retryable: false });
    expect(mapped).toBeInstanceOf(BridgeError);
    expect((mapped as BridgeError).code).toBe("timeout");
  });
});

describe("the token comes from the config directory", () => {
  it("reads the token the bridge wrote, and names the path when it is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-ava-adapter-"));
    writeFileSync(join(dir, "token"), "unit-test-token\n", { mode: 0o600 });
    expect(readToken({ AVA_BRIDGE_CONFIG_DIR: dir } as NodeJS.ProcessEnv)).toBe("unit-test-token");

    const empty = mkdtempSync(join(tmpdir(), "gb-ava-adapter-empty-"));
    expect(() => readToken({ AVA_BRIDGE_CONFIG_DIR: empty } as NodeJS.ProcessEnv)).toThrow(/no bridge token at/);
  });

  it("refuses any host but 127.0.0.1, the only address the bridge binds (ADR 0005)", () => {
    expect(() => new BridgeClient({ host: "10.0.0.4", token: "x" })).toThrow(/127\.0\.0\.1 only/);
    expect(() => new BridgeClient({ host: "127.0.0.1", token: "x" })).not.toThrow();
  });
});

describe("stall classification", () => {
  it("names CAPTCHA only when one is visible", () => {
    expect(classifyStall({ captchaPresent: true })).toBe("captcha");
    expect(classifyStall({ captchaPresent: false })).toBeNull();
  });
});

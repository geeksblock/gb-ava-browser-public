import { describe, expect, it } from "vitest";
import { createLogger, fingerprint, type LogRecord } from "@gb-ava/protocol";

function collect(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (record) => records.push(record) };
}

const TOKEN = "s3cr3t-token-value-abcdefghijklmnop";

describe("log redaction", () => {
  it("never emits a registered secret, even inside a larger string", () => {
    const { records, sink } = collect();
    const logger = createLogger({ scope: "test", sink, secrets: [TOKEN] });
    logger.info(`connecting with token ${TOKEN}`, { url: `ws://127.0.0.1:8765/?t=${TOKEN}` });
    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).toContain("[redacted]");
  });

  it("redacts by key name even when the value was not registered", () => {
    const { records, sink } = collect();
    const logger = createLogger({ scope: "test", sink });
    logger.info("hello", { token: "unregistered", authorization: "Bearer x", attempts: 2 });
    expect(records[0]?.fields).toEqual({ token: "[redacted]", authorization: "[redacted]", attempts: 2 });
  });

  it("redacts nested objects and arrays", () => {
    const { records, sink } = collect();
    const logger = createLogger({ scope: "test", sink, secrets: [TOKEN] });
    logger.warn("nested", { hello: { client: { note: TOKEN } }, list: [TOKEN, "safe"] });
    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain(TOKEN);
  });

  it("keeps Error messages while redacting them", () => {
    const { records, sink } = collect();
    const logger = createLogger({ scope: "test", sink, secrets: [TOKEN] });
    logger.error("failed", { error: new Error(`bad token ${TOKEN}`) });
    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).toContain("bad token");
  });

  it("respects the configured level", () => {
    const { records, sink } = collect();
    const logger = createLogger({ scope: "test", sink, level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    expect(records.map((record) => record.level)).toEqual(["warn"]);
  });

  it("logs a fingerprint, which matches the token key rule but is not the secret", () => {
    const { records, sink } = collect();
    const logger = createLogger({ scope: "test", sink, secrets: [TOKEN] });
    logger.info("extension connected", { tokenFingerprint: fingerprint(TOKEN), token: TOKEN, attempts: 1 });
    expect(records[0]?.fields).toEqual({
      tokenFingerprint: fingerprint(TOKEN),
      token: "[redacted]",
      attempts: 1,
    });
    expect(JSON.stringify(records)).not.toContain(TOKEN);
  });
});

describe("fingerprint", () => {
  it("is short, stable and not the secret", () => {
    const fp = fingerprint(TOKEN);
    expect(fp).toHaveLength(8);
    expect(fp).toBe(fingerprint(TOKEN));
    expect(TOKEN).not.toContain(fp);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it("separates different tokens", () => {
    expect(fingerprint(TOKEN)).not.toBe(fingerprint(`${TOKEN}x`));
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_BACKOFF, nextDelayMs } from "../../extension/src/lib/backoff.js";

const noJitter = (): number => 0.5;

describe("reconnect backoff", () => {
  it("starts at the base delay and grows", () => {
    expect(nextDelayMs(1, DEFAULT_BACKOFF, noJitter)).toBe(500);
    expect(nextDelayMs(2, DEFAULT_BACKOFF, noJitter)).toBe(1000);
    expect(nextDelayMs(3, DEFAULT_BACKOFF, noJitter)).toBe(2000);
    expect(nextDelayMs(4, DEFAULT_BACKOFF, noJitter)).toBe(4000);
  });

  it("caps at the maximum delay and never exceeds it by more than the jitter allowance", () => {
    const cap = DEFAULT_BACKOFF.maxMs * (1 + DEFAULT_BACKOFF.jitterRatio);
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const delay = nextDelayMs(attempt, DEFAULT_BACKOFF, () => 0.999);
      expect(delay).toBeLessThanOrEqual(Math.round(cap));
    }
  });

  it("stays positive with maximum downward jitter", () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(nextDelayMs(attempt, DEFAULT_BACKOFF, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });

  it("treats attempt 0 or negative as the first attempt", () => {
    expect(nextDelayMs(0, DEFAULT_BACKOFF, noJitter)).toBe(500);
    expect(nextDelayMs(-5, DEFAULT_BACKOFF, noJitter)).toBe(500);
  });

  it("jitters within the configured band", () => {
    const low = nextDelayMs(3, DEFAULT_BACKOFF, () => 0);
    const high = nextDelayMs(3, DEFAULT_BACKOFF, () => 1);
    expect(low).toBeLessThan(2000);
    expect(high).toBeGreaterThan(2000);
    expect(high - low).toBeLessThanOrEqual(2000 * DEFAULT_BACKOFF.jitterRatio * 2 + 2);
  });
});

/**
 * Exponential backoff for the extension's reconnect loop.
 *
 * Deterministic given a `random` source, so the unit tests can assert exact
 * sequences and the runtime still jitters (a herd of extensions reconnecting to
 * one bridge should not line up).
 */

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor: number;
  /** Fraction of the delay that may be added or removed, 0..1. */
  jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitterRatio: 0.2,
};

export function nextDelayMs(attempt: number, options: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = options.baseMs * options.factor ** (safeAttempt - 1);
  const capped = Math.min(raw, options.maxMs);
  const jitter = capped * options.jitterRatio * (random() * 2 - 1);
  const delay = Math.round(capped + jitter);
  return Math.max(0, Math.min(Math.round(options.maxMs * (1 + options.jitterRatio)), delay));
}

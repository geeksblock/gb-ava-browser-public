/**
 * The connection supervisor, as a pure state machine.
 *
 * MV3 suspension is the product's primary reliability risk (IMPLEMENTATION-PLAN
 * §10.3), so the decisions live here — no chrome.* API, no timers, no sockets —
 * and are unit-tested against the exact transitions. The service worker only
 * executes the returned effects. That separation is deliberate: when a flaky
 * "agent went deaf" report appears, the state machine can be replayed offline.
 *
 * Deliberately absent: any notion of a pending command. A dropped socket fails
 * the in-flight calls at the runtime layer and nothing is replayed
 * (AGENTS.md rule 5); the supervisor only decides *when to reconnect*.
 */

import { HANDSHAKE_TIMEOUT_MS } from "@gb-ava/protocol";
import { DEFAULT_BACKOFF, nextDelayMs, type BackoffOptions } from "./backoff.js";

export const CONNECT_TIMEOUT_MS = 10_000;

export type SupervisorPhase = "unconfigured" | "idle" | "connecting" | "handshaking" | "connected" | "backoff" | "blocked" | "stopped";

export interface SupervisorState {
  phase: SupervisorPhase;
  /** Consecutive failed attempts; reset on a successful handshake. */
  attempts: number;
  /** Epoch ms of the last transition, for diagnostics and timeouts. */
  since: number;
  /** Set while `connecting` or `handshaking`. */
  attemptStartedAt?: number;
  /** Set while `backoff`. */
  nextAttemptAt?: number;
  /** Set while `connected`. */
  sessionId?: string;
  connectedAt?: number;
  /** Set while `blocked` — needs a human (wrong token, protocol mismatch). */
  blockedReason?: string;
  /** True once this worker lifetime has completed a handshake. */
  hasHandshaked: boolean;
}

export type SupervisorEvent =
  | { type: "boot"; now: number; hasToken: boolean; hasHandshaked: boolean }
  | { type: "settings_changed"; now: number; hasToken: boolean }
  | { type: "reconnect_requested"; now: number; hasToken: boolean }
  | { type: "tick"; now: number }
  | { type: "socket_open"; now: number }
  | { type: "handshake_ok"; now: number; sessionId: string }
  | { type: "handshake_rejected"; now: number; code: "unauthorized" | "protocol_mismatch" | "invalid" }
  /**
   * The peer could not prove it holds the token (ADR 0005): either the pasted
   * token is wrong, or something other than the bridge holds the port. The two
   * look identical from here, and both need a human, so this blocks (fail closed)
   * exactly like a refused token instead of retrying into a possible impostor.
   */
  | { type: "handshake_unverified"; now: number; reason: string }
  | { type: "socket_closed"; now: number }
  | { type: "connect_failed"; now: number }
  | { type: "stop"; now: number };

export type SupervisorEffect =
  | { type: "connect" }
  | { type: "send_hello" }
  | { type: "send_ping" }
  | { type: "close_socket"; reason: string }
  | { type: "schedule_retry"; delayMs: number; attempt: number }
  | { type: "note"; level: "info" | "warn"; message: string; fields?: Record<string, unknown> };

export interface ReduceOptions {
  backoff?: Partial<BackoffOptions>;
  random?: () => number;
}

export interface ReduceResult {
  state: SupervisorState;
  effects: SupervisorEffect[];
}

export function initialState(now: number): SupervisorState {
  return { phase: "idle", attempts: 0, since: now, hasHandshaked: false };
}

function toConnecting(state: SupervisorState, now: number, effects: SupervisorEffect[]): SupervisorState {
  effects.push({ type: "connect" });
  return {
    ...state,
    phase: "connecting",
    attemptStartedAt: now,
    since: now,
    nextAttemptAt: undefined,
  };
}

function toBackoff(
  state: SupervisorState,
  now: number,
  options: ReduceOptions,
  effects: SupervisorEffect[],
  reason: string,
): SupervisorState {
  const attempt = state.attempts + 1;
  const delayMs = nextDelayMs(attempt, { ...DEFAULT_BACKOFF, ...options.backoff }, options.random ?? Math.random);
  effects.push({ type: "schedule_retry", delayMs, attempt });
  effects.push({ type: "note", level: "warn", message: "reconnect scheduled", fields: { attempt, delayMs, reason } });
  return {
    ...state,
    phase: "backoff",
    attempts: attempt,
    attemptStartedAt: undefined,
    nextAttemptAt: now + delayMs,
    since: now,
  };
}

export function reduce(state: SupervisorState, event: SupervisorEvent, options: ReduceOptions = {}): ReduceResult {
  const effects: SupervisorEffect[] = [];

  // A stopped supervisor never reconnects. Only an explicit boot or settings
  // change (which means a human edited the configuration) leaves this phase.
  if (state.phase === "stopped" && event.type !== "boot" && event.type !== "settings_changed") {
    return { state, effects };
  }

  switch (event.type) {
    case "boot": {
      const next = { ...state, hasHandshaked: event.hasHandshaked, since: event.now, attempts: 0 };
      if (!event.hasToken) {
        return { state: { ...next, phase: "unconfigured", attemptStartedAt: undefined, nextAttemptAt: undefined }, effects };
      }
      return { state: toConnecting(next, event.now, effects), effects };
    }

    case "settings_changed": {
      effects.push({ type: "close_socket", reason: "settings_changed" });
      const reset: SupervisorState = {
        ...state,
        attempts: 0,
        sessionId: undefined,
        connectedAt: undefined,
        blockedReason: undefined,
        attemptStartedAt: undefined,
        nextAttemptAt: undefined,
        since: event.now,
      };
      if (!event.hasToken) {
        return { state: { ...reset, phase: "unconfigured" }, effects };
      }
      return { state: toConnecting(reset, event.now, effects), effects };
    }

    case "reconnect_requested": {
      if (!event.hasToken) {
        effects.push({ type: "close_socket", reason: "no_token" });
        return {
          state: { ...state, phase: "unconfigured", attempts: 0, sessionId: undefined, connectedAt: undefined, since: event.now },
          effects,
        };
      }
      effects.push({ type: "close_socket", reason: "reconnect_requested" });
      const reset: SupervisorState = {
        ...state,
        attempts: 0,
        sessionId: undefined,
        connectedAt: undefined,
        blockedReason: undefined,
        since: event.now,
      };
      return { state: toConnecting(reset, event.now, effects), effects };
    }

    case "tick": {
      if (state.phase === "connected") {
        effects.push({ type: "send_ping" });
        return { state, effects };
      }
      if (state.phase === "backoff") {
        if (state.nextAttemptAt !== undefined && event.now >= state.nextAttemptAt) {
          return { state: toConnecting(state, event.now, effects), effects };
        }
        return { state, effects };
      }
      if (state.phase === "connecting" || state.phase === "handshaking") {
        const startedAt = state.attemptStartedAt ?? state.since;
        const limit = state.phase === "handshaking" ? HANDSHAKE_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
        if (event.now - startedAt > limit) {
          effects.push({ type: "close_socket", reason: "attempt_timeout" });
          return { state: toBackoff(state, event.now, options, effects, "attempt_timeout"), effects };
        }
        return { state, effects };
      }
      if (state.phase === "idle") {
        return { state: toConnecting(state, event.now, effects), effects };
      }
      // unconfigured / blocked: waiting for a human, nothing to do on a tick.
      return { state, effects };
    }

    case "socket_open": {
      if (state.phase !== "connecting") {
        // A socket opened while we believed we were connected: close the duplicate.
        effects.push({ type: "close_socket", reason: "unexpected_open" });
        return { state, effects };
      }
      effects.push({ type: "send_hello" });
      return { state: { ...state, phase: "handshaking", attemptStartedAt: event.now, since: event.now }, effects };
    }

    case "handshake_ok": {
      effects.push({ type: "note", level: "info", message: "extension handshake complete", fields: { sessionId: event.sessionId } });
      return {
        state: {
          ...state,
          phase: "connected",
          attempts: 0,
          sessionId: event.sessionId,
          connectedAt: event.now,
          attemptStartedAt: undefined,
          nextAttemptAt: undefined,
          blockedReason: undefined,
          since: event.now,
          hasHandshaked: true,
        },
        effects,
      };
    }

    case "handshake_rejected": {
      effects.push({ type: "close_socket", reason: `handshake_${event.code}` });
      // Rejection is a human problem: a wrong token or a version mismatch will not
      // fix itself, so stop hammering and report it.
      effects.push({ type: "note", level: "warn", message: "handshake rejected; waiting for configuration change", fields: { code: event.code } });
      return {
        state: {
          ...state,
          phase: "blocked",
          blockedReason: event.code,
          attempts: 0,
          attemptStartedAt: undefined,
          nextAttemptAt: undefined,
          sessionId: undefined,
          connectedAt: undefined,
          since: event.now,
        },
        effects,
      };
    }

    case "handshake_unverified": {
      effects.push({ type: "close_socket", reason: "bridge_unverified" });
      effects.push({ type: "note", level: "warn", message: "bridge not verified; waiting for a human", fields: { reason: event.reason } });
      return {
        state: {
          ...state,
          phase: "blocked",
          blockedReason: "bridge_unverified",
          attempts: 0,
          attemptStartedAt: undefined,
          nextAttemptAt: undefined,
          sessionId: undefined,
          connectedAt: undefined,
          since: event.now,
        },
        effects,
      };
    }

    case "socket_closed": {
      if (state.phase === "backoff" || state.phase === "blocked" || state.phase === "unconfigured" || state.phase === "idle") {
        return { state, effects };
      }
      return { state: toBackoff(state, event.now, options, effects, "socket_closed"), effects };
    }

    case "connect_failed": {
      if (state.phase === "backoff" || state.phase === "blocked" || state.phase === "unconfigured") {
        return { state, effects };
      }
      return { state: toBackoff(state, event.now, options, effects, "connect_failed"), effects };
    }

    case "stop": {
      effects.push({ type: "close_socket", reason: "stopped" });
      return {
        state: { ...state, phase: "stopped", attemptStartedAt: undefined, nextAttemptAt: undefined, sessionId: undefined, connectedAt: undefined, since: event.now },
        effects,
      };
    }

    default: {
      const exhaustive: never = event;
      return { state, effects: exhaustive ? effects : effects };
    }
  }
}

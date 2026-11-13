/**
 * A command failure that already knows its protocol error.
 *
 * Commands fail in ways the protocol names (`not_found`, `tab_changed`, `timeout`,
 * `debugger_unavailable`, …). Throwing the payload from the point of failure keeps
 * the mapping in one place; anything else that escapes a handler is `internal`,
 * which is the honest answer for a bug.
 */

import { makeError, type ErrorCode, type ErrorPayload, type JsonObject } from "@gb-ava/protocol";

export class CommandError extends Error {
  readonly payload: ErrorPayload;

  constructor(payload: ErrorPayload) {
    super(payload.message);
    this.name = "CommandError";
    this.payload = payload;
  }
}

export function commandError(code: ErrorCode, message: string, retryable?: boolean, detail?: JsonObject): CommandError {
  return new CommandError(makeError(code, message, retryable, detail));
}

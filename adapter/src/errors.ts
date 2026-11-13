/**
 * The Cua-shaped adapter.
 *
 * Cua's browser tools are a flat set of `browser_*` calls: navigate, read, click,
 * type, key, scroll, select, upload, download, wait, screenshot, evaluate, tabs.
 * This package exposes exactly that shape and nothing else, and translates each
 * call into one protocol method on the local bridge.
 *
 * Two rules make it worth having as its own layer rather than letting a caller
 * speak the protocol directly:
 *   - a failure surfaces as a `NeedsHumanError` with a reason the agent can act on
 *     (ask the owner, do not guess), and the browser is never auto-dismissed;
 *   - the agent never sees a tab id it did not ask for: every result names the tab
 *     it came from, and every call names the tab it acts on.
 */

export type NeedsHumanReason =
  | "webauthn"
  | "permission_prompt"
  | "javascript_dialog"
  | "file_picker"
  | "captcha"
  /** The extension said a human is needed but did not name why. Never guessed. */
  | "unknown";

/** A command that cannot finish until a human does something. Never retried, never dismissed. */
export class NeedsHumanError extends Error {
  readonly reason: NeedsHumanReason;
  readonly tabId: number | null;
  readonly detail: Record<string, unknown>;

  constructor(reason: NeedsHumanReason, message: string, tabId: number | null, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "NeedsHumanError";
    this.reason = reason;
    this.tabId = tabId;
    this.detail = detail;
  }
}

/** Every other failure: the protocol's own code, kept verbatim so a caller can branch on it. */
export class BridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, retryable: boolean, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

const HUMAN_REASONS: ReadonlySet<string> = new Set([
  "webauthn",
  "permission_prompt",
  "javascript_dialog",
  "file_picker",
  "captcha",
  "unknown",
]);

/**
 * Turn a bridge failure into the adapter's error. `needs_human` becomes a typed
 * error with its reason preserved, because "a human must act" is a different kind
 * of answer from "the command failed".
 */
export function toAdapterError(error: {
  code: string;
  message: string;
  retryable: boolean;
  detail?: Record<string, unknown>;
  tabId?: number | null;
}): NeedsHumanError | BridgeError {
  const detail = error.detail ?? {};
  if (error.code === "needs_human") {
    // The reason is preserved when the extension names one, and `unknown` when it
    // does not — never rewritten to a reason the caller might act on wrongly.
    const raw = detail["reason"];
    const reason = typeof raw === "string" && HUMAN_REASONS.has(raw) ? raw : "unknown";
    const detailTab = typeof detail["tabId"] === "number" ? detail["tabId"] : null;
    return new NeedsHumanError(reason as NeedsHumanReason, error.message, error.tabId ?? detailTab, detail);
  }
  return new BridgeError(error.code, error.message, error.retryable, detail);
}

/**
 * A stalled command is not automatically a human problem, so this only names a
 * reason it can justify: a visible CAPTCHA on the page. Anything else stays the
 * protocol's timeout, which is the honest answer.
 */
export function classifyStall(facts: { captchaPresent: boolean }): NeedsHumanReason | null {
  return facts.captchaPresent ? "captcha" : null;
}

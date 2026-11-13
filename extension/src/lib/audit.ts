/**
 * The audit ring buffer (plan §6, M5).
 *
 * Every command the extension executes is recorded — method, tab, a bounded
 * argument summary, the outcome and how long it took — so "what did Ava do?" has
 * an answer that is not a debugger session. Two things are deliberately absent:
 *
 *   - **page content.** The buffer never holds a read's text, an AX tree or a PNG.
 *     Only what was asked and what came back as a status.
 *   - **secrets.** The argument summary is built per method; `page.type` records a
 *     character count instead of the text, so a password never lands in the ring.
 *
 * Pure: no chrome.*, so the rules are unit-tested.
 */

export const AUDIT_CAPACITY = 500;
/** Bound on the argument summary; a long expression must not bloat the buffer. */
export const AUDIT_SUMMARY_MAX = 200;

export interface AuditEntry {
  at: string;
  method: string;
  tabId: number | null;
  /** Bounded, secret-free description of the arguments. */
  args: string;
  outcome: "ok" | "error" | "needs_human";
  /** Protocol error code, when the outcome was not ok. */
  code: string | null;
  durationMs: number;
}

export interface AuditSnapshot {
  capacity: number;
  size: number;
  recent: AuditEntry[];
}

/**
 * A summary that is useful to a human and safe to keep: the keys that identify the
 * command, never the payload. `page.type` says how much was typed, not what.
 */
export function summariseArgs(method: string, params: Record<string, unknown> | undefined): string {
  if (params === undefined) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (key === "text") {
      parts.push(`text:${typeof value === "string" ? `${value.length}ch` : "?"}`);
      continue;
    }
    if (key === "expression") {
      parts.push(`expression:${typeof value === "string" ? `${value.length}ch` : "?"}`);
      continue;
    }
    if (key === "files") {
      parts.push(`files:${Array.isArray(value) ? value.length : "?"}`);
      continue;
    }
    if (key === "png") {
      parts.push("png");
      continue;
    }
    if (typeof value === "string") {
      // A URL, selector or key is safe; a long one is cut rather than kept whole.
      parts.push(`${key}:${value.length > 60 ? `${value.slice(0, 60)}…` : value}`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}:${String(value)}`);
      continue;
    }
    if (Array.isArray(value)) {
      parts.push(`${key}:[${value.length}]`);
      continue;
    }
    if (value === null || typeof value === "object") {
      parts.push(`${key}:{…}`);
    }
  }
  const joined = parts.join(" ");
  void method;
  return joined.length > AUDIT_SUMMARY_MAX ? `${joined.slice(0, AUDIT_SUMMARY_MAX)}…` : joined;
}

export function outcomeFor(code: string | null): AuditEntry["outcome"] {
  if (code === null) return "ok";
  return code === "needs_human" ? "needs_human" : "error";
}

/** Fixed-capacity ring: the oldest entry is overwritten, never an unbounded array. */
export class AuditRing {
  private readonly entries: AuditEntry[] = [];

  constructor(private readonly capacity: number = AUDIT_CAPACITY) {}

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  size(): number {
    return this.entries.length;
  }

  /** Newest first, bounded, and copies so a caller cannot mutate the buffer. */
  recent(limit = 20): AuditEntry[] {
    const bound = Math.max(1, Math.min(limit, this.capacity));
    return this.entries.slice(-bound).reverse().map((entry) => ({ ...entry }));
  }

  snapshot(limit = 20): AuditSnapshot {
    return { capacity: this.capacity, size: this.entries.length, recent: this.recent(limit) };
  }
}

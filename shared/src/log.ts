/**
 * Structured logging with secret redaction, shared by the bridge and the
 * extension so both obey the same rule: a secret value never reaches a sink.
 *
 * Redaction is applied twice:
 *   1. by key name (`token`, `authorization`, `password`, … -> "[redacted]");
 *   2. by value, for every secret registered with the logger, including
 *      substrings (a token embedded in a URL must not leak either).
 *
 * A short, non-reversible *fingerprint* may be logged instead of a secret so an
 * operator can correlate a pasted token with the one the bridge holds. It is a
 * log-correlation id, not a security primitive (see fingerprint.ts).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  fields?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|authorization|apikey|api_key|cookie)/i;
/**
 * A fingerprint *of* a secret is not the secret: the 8-hex correlation id is
 * meant to be logged, and the operators' runbooks promise it will be. Without
 * this exemption every `tokenFingerprint` field would be redacted (it matches
 * the key rule) and the promise would silently be false.
 */
const FINGERPRINT_KEY_PATTERN = /fingerprint$/i;
const REDACTED = "[redacted]";

function isRedactedKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) && !FINGERPRINT_KEY_PATTERN.test(key);
}

export interface LoggerOptions {
  scope: string;
  sink: LogSink;
  /** Actual secret values (never logged). */
  secrets?: readonly string[];
  /** Minimum level to emit. */
  level?: LogLevel;
  now?: () => Date;
}

export interface Logger {
  readonly scope: string;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function redactValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") {
    let out = value;
    for (const secret of secrets) {
      if (secret.length > 0 && out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactValue(value.message, secrets, depth + 1) };
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isRedactedKey(key) ? REDACTED : redactValue(inner, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const secrets = [...(options.secrets ?? [])].filter((s) => s.length > 0);
  const minLevel = LEVEL_ORDER[options.level ?? "info"];
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const record: LogRecord = {
      time: now().toISOString(),
      level,
      scope,
      message: String(redactValue(message, secrets)),
    };
    if (fields !== undefined) {
      record.fields = redactValue(fields, secrets) as Record<string, unknown>;
    }
    options.sink(record);
  };

  const make = (scope: string): Logger => ({
    scope,
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
    child: (childScope: string) => make(childScope),
  });

  return make(options.scope);
}

export { REDACTED };

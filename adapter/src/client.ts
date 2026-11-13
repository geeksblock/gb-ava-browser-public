/**
 * The bridge client the adapter speaks through.
 *
 * It reads the per-install token from the same config directory the bridge writes
 * (`~/.config/gb-ava-bridge/token`, 0600) rather than taking it as an argument, so
 * an adapter process never has to be handed a secret on a command line. The token
 * is sent only to 127.0.0.1.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "./errors.js";

export interface ClientOptions {
  /** Defaults to 127.0.0.1:8765. */
  port?: number;
  host?: string;
  /** Overrides reading the token from the config directory. */
  token?: string;
  /** Per-call timeout; long-running methods override it internally. */
  timeoutMs?: number;
}

const LONG_RUNNING = new Set(["page.waitFor", "page.download", "page.evaluate", "tabs.navigate"]);

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["AVA_BRIDGE_CONFIG_DIR"];
  if (override !== undefined && override.trim().length > 0) return override;
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "gb-ava-bridge");
}

export function readToken(env: NodeJS.ProcessEnv = process.env): string {
  const path = join(configDirectory(env), "token");
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token.length === 0) throw new Error("empty");
    return token;
  } catch {
    throw new BridgeError(
      "unauthorized",
      `no bridge token at ${path} — start the bridge once (gb-ava-bridge serve) and pair the extension`,
      false,
    );
  }
}

interface Reply<T> {
  ok?: boolean;
  result?: T;
  error?: { code: string; message: string; retryable: boolean; detail?: Record<string, unknown> };
}

export class BridgeClient {
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    // The token travels in clear text over plain HTTP, so the host must be this
    // machine. Anything else would send the secret across a network for no gain —
    // the bridge binds loopback only.
    if (this.host !== "127.0.0.1" && this.host !== "localhost" && this.host !== "::1") {
      throw new BridgeError("invalid_request", `the bridge is loopback only; "${this.host}" is not`, false);
    }
    this.port = options.port ?? Number.parseInt(process.env["AVA_BRIDGE_PORT"] ?? "8765", 10);
    this.token = options.token ?? readToken();
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** One protocol method, one answer. Never retried here. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = JSON.stringify({ id: `adapter-${Date.now()}-${Math.random().toString(16).slice(2)}`, method, params });
    const budget = LONG_RUNNING.has(method) ? 70_000 : this.timeoutMs;
    let response: Response;
    try {
      response = await fetch(`http://${this.host}:${this.port}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body,
        signal: AbortSignal.timeout(budget),
      });
    } catch (error) {
      throw new BridgeError(
        "extension_disconnected",
        `cannot reach the bridge on ${this.host}:${this.port} (${(error as Error).message})`,
        true,
      );
    }

    const payload = (await response.json().catch(() => null)) as Reply<T> | null;
    if (payload === null) {
      throw new BridgeError("internal", `the bridge answered ${response.status} with no JSON`, false);
    }
    if (payload.ok === true) return payload.result as T;
    const failure = payload.error ?? { code: "internal", message: "unknown bridge error", retryable: false };
    throw new BridgeError(failure.code, failure.message, failure.retryable, failure.detail ?? {});
  }

  /** The bridge's health, for a caller that wants to check before acting. */
  async health(): Promise<Record<string, unknown>> {
    const response = await fetch(`http://${this.host}:${this.port}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new BridgeError("internal", `health answered ${response.status}`, false);
    return (await response.json()) as Record<string, unknown>;
  }
}

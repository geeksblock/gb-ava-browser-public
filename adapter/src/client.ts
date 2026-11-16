/**
 * The bridge client the adapter speaks through.
 *
 * It reads the per-install token from the same config directory the bridge writes
 * (`~/.config/gb-ava-bridge/token`, 0600) rather than taking it as an argument, so
 * an adapter process never has to be handed a secret on a command line.
 *
 * The token itself is never sent (ADR 0005). Each call first makes the bridge
 * prove it holds the token, then sends a one-time proof over the exact request
 * body, then checks the bridge's proof over the exact answer. Whatever else might
 * be listening on the port learns nothing and cannot feed the agent a fake result.
 * The proof format mirrors `shared/src/handshake.ts`; a unit test pins the two.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

export const RPC_PROOF_LABELS = {
  server: "gb-ava/v2/rpc-server",
  client: "gb-ava/v2/rpc-client",
  response: "gb-ava/v2/rpc-response",
} as const;

export function rpcProof(token: string, label: string, parts: readonly string[]): string {
  return createHmac("sha256", token).update([label, ...parts].join("\n"), "utf8").digest("base64url");
}

function proofMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const NONCE = /^[A-Za-z0-9_-]{43}$/;

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
    // The bridge binds 127.0.0.1 only. "localhost" may resolve to ::1, where the
    // bridge never listens and another account could sit and relay (ADR 0005), so
    // only the exact address the bridge binds is accepted — as in the extension.
    if (this.host !== "127.0.0.1") {
      throw new BridgeError("invalid_request", `the bridge listens on 127.0.0.1 only; "${this.host}" is not accepted`, false);
    }
    this.port = options.port ?? Number.parseInt(process.env["AVA_BRIDGE_PORT"] ?? "8765", 10);
    this.token = options.token ?? readToken();
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** One protocol method, one answer. Never retried here. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = JSON.stringify({ id: `adapter-${Date.now()}-${Math.random().toString(16).slice(2)}`, method, params });
    const budget = LONG_RUNNING.has(method) ? 70_000 : this.timeoutMs;
    const signal = AbortSignal.timeout(budget);
    const base = `http://${this.host}:${this.port}`;
    const unreachable = (error: unknown): BridgeError =>
      new BridgeError(
        "extension_disconnected",
        `cannot reach the bridge on ${this.host}:${this.port} (${(error as Error).message})`,
        true,
      );
    const unverified = (what: string): BridgeError =>
      new BridgeError(
        "unauthorized",
        `${what}: whatever is answering on ${this.host}:${this.port} could not prove it holds the bridge token — ` +
          "check that the real bridge is running",
        false,
      );

    // 1. The bridge proves itself before anything token-derived is sent.
    const clientNonce = randomBytes(32).toString("base64url");
    let challenge: { ok?: boolean; serverNonce?: unknown; serverProof?: unknown; error?: Reply<T>["error"] } | null;
    try {
      const response = await fetch(`${base}/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientNonce }),
        signal,
      });
      challenge = (await response.json().catch(() => null)) as typeof challenge;
    } catch (error) {
      throw unreachable(error);
    }
    if (challenge === null || challenge.ok !== true) {
      const failure = challenge?.error ?? { code: "internal", message: "the bridge refused the challenge", retryable: false };
      throw new BridgeError(failure.code, failure.message, failure.retryable, failure.detail ?? {});
    }
    const serverNonce = challenge.serverNonce;
    if (
      typeof serverNonce !== "string" ||
      !NONCE.test(serverNonce) ||
      !proofMatches(rpcProof(this.token, RPC_PROOF_LABELS.server, [clientNonce, serverNonce]), challenge.serverProof)
    ) {
      throw unverified("bridge not verified");
    }

    // 2. A one-time proof over this exact body.
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${base}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ava-nonce": serverNonce,
          "x-ava-proof": rpcProof(this.token, RPC_PROOF_LABELS.client, [serverNonce, sha256Hex(body)]),
        },
        body,
        signal,
      });
      text = await response.text();
    } catch (error) {
      throw unreachable(error);
    }

    // 3. An answer that will be acted on must carry the bridge's proof over its
    // exact bytes: any 200, and any body claiming success whatever its status. An
    // unsigned error (401, 413) is only ever reported as a failure.
    let claimsSuccess = false;
    try {
      claimsSuccess = (JSON.parse(text) as { ok?: unknown } | null)?.ok === true;
    } catch {
      claimsSuccess = false;
    }
    if (
      (response.status === 200 || claimsSuccess) &&
      !proofMatches(
        rpcProof(this.token, RPC_PROOF_LABELS.response, [serverNonce, sha256Hex(text)]),
        response.headers.get("x-ava-response-proof"),
      )
    ) {
      throw unverified("answer not verified");
    }

    let payload: Reply<T> | null = null;
    try {
      payload = JSON.parse(text) as Reply<T>;
    } catch {
      payload = null;
    }
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

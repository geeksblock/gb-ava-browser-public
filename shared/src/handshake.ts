/**
 * Mutual proof of the per-install token (ADR 0005).
 *
 * The raw token never crosses the wire. Each side proves it holds the token with
 * HMAC-SHA256 over two fresh nonces and a label that names the direction, so a
 * proof made for one purpose can never be replayed for another:
 *
 *   server proof  = HMAC(token, "gb-ava/v2/ws-server\n"  + clientNonce + "\n" + serverNonce)
 *   client proof  = HMAC(token, "gb-ava/v2/ws-client\n"  + clientNonce + "\n" + serverNonce)
 *
 * The *server* proves itself first. Whatever answers on the bridge port without
 * the token (a process that took the port while the real bridge was down) cannot
 * produce a server proof, so the client stops before it sends anything derived
 * from the token, and never acts on that peer's requests.
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`), which exists in both the MV3
 * service worker and Node 20+, so the extension and the bridge share one
 * implementation. The adapter (no workspace dependencies) mirrors it with
 * `node:crypto`; a unit test pins the two to identical output.
 */

export const PROOF_LABELS = {
  wsServer: "gb-ava/v2/ws-server",
  wsClient: "gb-ava/v2/ws-client",
  rpcServer: "gb-ava/v2/rpc-server",
  rpcClient: "gb-ava/v2/rpc-client",
  rpcResponse: "gb-ava/v2/rpc-response",
} as const;

export type ProofLabel = (typeof PROOF_LABELS)[keyof typeof PROOF_LABELS];

/** 32 random bytes, base64url: 43 characters. */
export const NONCE_LENGTH = 43;
/** HMAC-SHA256, base64url: 43 characters. */
export const PROOF_LENGTH = 43;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function isNonce(value: unknown): value is string {
  return typeof value === "string" && value.length === NONCE_LENGTH && BASE64URL.test(value);
}

export function isProof(value: unknown): value is string {
  return typeof value === "string" && value.length === PROOF_LENGTH && BASE64URL.test(value);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** The exact bytes a proof covers. Shared so every implementation agrees. */
export function proofMessage(label: ProofLabel, parts: readonly string[]): string {
  return [label, ...parts].join("\n");
}

export async function makeProof(token: string, label: ProofLabel, parts: readonly string[]): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(proofMessage(label, parts)));
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Constant-time comparison for equal-length ASCII strings (proofs are fixed
 * length, so a length mismatch reveals nothing a caller does not already know).
 */
export function proofsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyProof(
  token: string,
  label: ProofLabel,
  parts: readonly string[],
  presented: unknown,
): Promise<boolean> {
  if (!isProof(presented)) return false;
  return proofsEqual(await makeProof(token, label, parts), presented);
}

/** Lowercase hex SHA-256 of a UTF-8 string: binds an RPC proof to its exact body. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

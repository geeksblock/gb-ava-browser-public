/**
 * The client half of `/rpc` authentication (ADR 0005), for the CLI and the tests.
 * The adapter carries a `node:crypto` twin of this (it has no workspace
 * dependencies); a unit test pins both to the same proofs.
 *
 *   1. POST /auth/challenge { clientNonce }  ->  { serverNonce, serverProof }
 *   2. verify serverProof — if it fails, whatever answered does not hold the token:
 *      stop here, send nothing else
 *   3. POST /rpc with x-ava-nonce: serverNonce, x-ava-proof: HMAC over the body
 *   4. verify x-ava-response-proof over the exact response bytes before trusting it
 *
 * The token never leaves this process.
 */

import { PROOF_LABELS, isNonce, makeProof, newNonce, sha256Hex, verifyProof } from "./handshake.js";

export interface ProvenRpcResult {
  status: number;
  /** Parsed JSON body of the answer (already verified when it came from /rpc proper). */
  body: unknown;
}

export class BridgeUnverifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnverifiedError";
  }
}

export async function provenRpc(options: {
  host: string;
  port: number;
  token: string;
  body: string;
  timeoutMs: number;
}): Promise<ProvenRpcResult> {
  const base = `http://${options.host}:${options.port}`;
  const signal = AbortSignal.timeout(options.timeoutMs);
  const clientNonce = newNonce();
  const challengeResponse = await fetch(`${base}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientNonce }),
    signal,
  });
  const challenge = (await challengeResponse.json().catch(() => null)) as
    | { ok?: boolean; serverNonce?: unknown; serverProof?: unknown }
    | null;
  if (challenge === null || challenge.ok !== true) {
    return { status: challengeResponse.status, body: challenge };
  }
  const serverNonce = challenge.serverNonce;
  if (
    !isNonce(serverNonce) ||
    !(await verifyProof(options.token, PROOF_LABELS.rpcServer, [clientNonce, serverNonce], challenge.serverProof))
  ) {
    throw new BridgeUnverifiedError(
      `whatever is answering on ${options.host}:${options.port} could not prove it holds the bridge token`,
    );
  }
  const proof = await makeProof(options.token, PROOF_LABELS.rpcClient, [serverNonce, await sha256Hex(options.body)]);
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ava-nonce": serverNonce, "x-ava-proof": proof },
    body: options.body,
    signal,
  });
  const text = await response.text();
  const responseProof = response.headers.get("x-ava-response-proof");
  // An answer that will be acted on must carry the proof: any 200, and any body
  // claiming success whatever its status. An unsigned error (401, 413) is reported
  // as a failure and nothing more, which costs nothing an impostor could not
  // already do by refusing to answer.
  let claimsSuccess = false;
  try {
    claimsSuccess = (JSON.parse(text) as { ok?: unknown } | null)?.ok === true;
  } catch {
    claimsSuccess = false;
  }
  if (
    (response.status === 200 || claimsSuccess) &&
    !(await verifyProof(options.token, PROOF_LABELS.rpcResponse, [serverNonce, await sha256Hex(text)], responseProof))
  ) {
    throw new BridgeUnverifiedError("the bridge's answer did not carry a valid proof");
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

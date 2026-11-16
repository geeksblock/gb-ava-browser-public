/**
 * The loopback bridge.
 *
 * Responsibilities in M0:
 *   - bind 127.0.0.1 only (never a wildcard address);
 *   - accept exactly one authenticated extension socket, rejecting any other
 *     origin (a web page cannot connect just because it guessed the port);
 *   - perform the v2 mutual handshake (ADR 0005): the bridge proves it holds the
 *     per-install token before the extension proves it; the token never crosses
 *     the wire, on the socket or on `/rpc`;
 *   - refuse any `Host` that is not this listener (DNS rebinding);
 *   - answer `GET /health` with bridge state only; the extension's detailed health
 *     (audit trail, dialogs) is behind the token, via `/rpc` method `health`;
 *   - fail in-flight commands loudly when the socket drops. Never retried here;
 *     `page.click` and `page.type` are not idempotent (AGENTS.md rule 5).
 */

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_PRODUCT_NAME,
  BUILD_ID,
  BUILT_AT,
  HANDSHAKE_TIMEOUT_MS,
  MAX_MESSAGE_LENGTH,
  isV1Method,
  PROTOCOL_VERSION,
  WS_CLOSE,
  errorResponse,
  isBuildLabel,
  isClientAuth,
  isClientHello,
  isControlFrame,
  isNonce,
  makeProof,
  newNonce,
  PROOF_LABELS,
  sha256Hex,
  verifyProof,
  isErrorPayload,
  isPlainObject,
  isResponseEnvelope,
  makeError,
  okResponse,
  parseRequestEnvelope,
  type ClientHello,
  type ErrorPayload,
  type JsonObject,
  type JsonValue,
  type Logger,
  type RequestEnvelope,
} from "@gb-ava/protocol";
import { fingerprint } from "@gb-ava/protocol";

export const BRIDGE_VERSION = "0.1.0";
export const BIND_HOST = "127.0.0.1";
export const EXTENSION_PATH = "/extension";
/**
 * One frame on this socket can be a base64 screenshot (capped at 6,000,000
 * characters by the protocol) or a large accessibility tree. A 1 MB cap would
 * close the socket with 1009 on an ordinary reply, and the caller would see
 * `extension_disconnected` for a message that was simply big.
 */
const MAX_PAYLOAD_BYTES = 12_000_000;
/**
 * Before a socket has proved the token it may only send handshake frames, which
 * are tiny. A bigger frame is refused, and at most this many sockets may be
 * mid-handshake at once, so an unauthenticated local process cannot make the
 * bridge buffer many full-size frames.
 */
const MAX_PREAUTH_FRAME_BYTES = 4_096;
/**
 * At this many sockets mid-handshake, a new upgrade evicts the *oldest* pending
 * one instead of being refused. Refusing would let any local process hold every
 * slot with idle sockets and lock the real extension out; evicting means an
 * attacker must out-race a handshake that takes milliseconds, over and over.
 */
const MAX_PENDING_CONNECTIONS = 8;
/**
 * `/auth/challenge` nonces: single use, short-lived, bounded. When the table is
 * full the oldest nonce is dropped (not the new request refused), for the same
 * reason: a flood must not lock out a legitimate caller, who spends its nonce
 * within milliseconds of receiving it.
 */
const RPC_NONCE_TTL_MS = 30_000;
const MAX_OUTSTANDING_RPC_NONCES = 1_024;
const MAX_CHALLENGE_BODY_BYTES = 1_024;
export const RPC_NONCE_HEADER = "x-ava-nonce";
export const RPC_PROOF_HEADER = "x-ava-proof";
export const RPC_RESPONSE_PROOF_HEADER = "x-ava-response-proof";
const PEER_PING_INTERVAL_MS = 30_000;

/**
 * Methods whose own contract allows them to run longer than a normal request:
 * a wait, a download wait, an evaluate, a navigation. Giving them the default
 * 10 s meant the bridge always won the race and the caller got the bridge's
 * timeout instead of the method's own, more informative, error.
 */
const LONG_RUNNING_METHODS = new Set(["page.waitFor", "page.download", "page.evaluate", "tabs.navigate"]);
const LONG_RUNNING_TIMEOUT_MS = 65_000;
const PEER_DEAD_AFTER_MS = 10_000;

/**
 * The two cures for a build mismatch. Which one applies depends on which
 * side is older: a rebuilt unpacked extension keeps the worker script Chrome
 * cached at its last load (a Chrome restart does not refresh it), while a bridge
 * process keeps whatever bundle it was started with (a login service that keeps
 * it running survives rebuilds).
 */
const RELOAD_EXTENSION_HINT =
  "reload the unpacked extension at chrome://extensions (a Chrome restart does not refresh an unpacked extension)";
const RESTART_BRIDGE_HINT =
  "restart the bridge to load the newer code (stop and start `gb-ava-bridge serve`, or restart the login service that runs it)";

export interface BridgeOptions {
  port: number;
  token: string;
  allowedExtensionIds?: string[];
  logger: Logger;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  /**
   * The only folder `page.upload` may attach files from (ADR 0005). Chosen by the
   * human in the bridge config; undefined disables uploads entirely.
   */
  uploadDirectory?: string;
}

/**
 * One side's build identity: the commit it was built from and when.
 * `builtAt` is null when a side reports a build id but no timestamp (the hello
 * fields are independently optional); the ordering is then unknown, so the
 * diagnosis names both builds instead of guessing which is older.
 */
export interface BuildView {
  id: string;
  builtAt: string | null;
}

export interface BridgeHealth {
  ok: true;
  /**
   * Both sides' build identities, side by side. A rebuilt unpacked extension can
   * keep serving the script Chrome cached at its last load, so "the extension is
   * stale" is a fact this health answer must be able to state rather than a
   * theory an agent has to guess at.
   */
  build: {
    bridge: BuildView;
    /** null when no extension is connected, or it predates build stamping. */
    extension: BuildView | null;
    /** true when both report a stamp and they differ; null when nothing can be compared. */
    mismatch: boolean | null;
  };
  bridge: {
    name: string;
    version: string;
    protocolVersion: number;
    host: string;
    port: number;
    startedAt: string;
    uptimeMs: number;
    tokenConfigured: boolean;
    tokenFingerprint: string;
    allowedExtensionIds: string[];
    socketsSeen: number;
    uploadDirectory: string | null;
    /**
     * The last handshake refused before the peer proved the token. Any local
     * process can cause one, so it is a hint, never proof of what the extension saw.
     */
    lastRejectedHandshake?: { at: string; error: ErrorPayload };
  };
  extension: ExtensionHealthView;
}

export type ExtensionHealthView =
  | { connected: false; lastError?: ErrorPayload }
  | {
      connected: true;
      sessionId: string;
      connectedAt: string;
      connectedForMs: number;
      lastSeenAgoMs: number;
      remoteAddress: string;
      client: ClientHello["client"];
      /** Only filled for an authenticated caller; `GET /health` never carries it. */
      health: JsonValue | null;
      healthError?: ErrorPayload;
    };

export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== "string" || address.length === 0) return false;
  const value = address.toLowerCase();
  return value === "::1" || value === "127.0.0.1" || value.startsWith("127.") || value === "::ffff:127.0.0.1";
}

/**
 * Origin policy. An absent Origin is allowed: non-browser loopback clients
 * (the CLI, tests) do not send one, and the bind address plus token still apply.
 * Any origin that *is* present must be the extension's.
 */
export function isAllowedOrigin(origin: string | undefined, allowedExtensionIds: readonly string[]): boolean {
  if (origin === undefined || origin.length === 0) return true;
  const prefix = "chrome-extension://";
  if (!origin.startsWith(prefix)) return false;
  const id = origin.slice(prefix.length);
  if (id.length === 0) return false;
  if (allowedExtensionIds.length === 0) return true;
  return allowedExtensionIds.includes(id);
}

/**
 * DNS rebinding: a page on attacker.example can make its own name resolve to
 * 127.0.0.1, and a same-origin request then carries no Origin header. Its Host
 * header still names attacker.example, so only this listener's own names pass.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  const value = host.toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`;
}

export const MAX_RPC_BODY_BYTES = 256_000;

/**
 * Resolve each upload path inside the human-chosen upload folder. Symlinks and
 * `..` are resolved first, so neither can reach outside it. Returns the real
 * paths, which are what the extension attaches.
 */
export function resolveUploadPaths(
  files: unknown,
  uploadDirectory: string | undefined,
): { ok: true; files: string[] } | { ok: false; error: ErrorPayload } {
  if (uploadDirectory === undefined) {
    return { ok: false, error: makeError("invalid_request", "uploads are disabled: no upload folder is configured for the bridge", false) };
  }
  let root: string;
  try {
    root = realpathSync(uploadDirectory);
    const info = statSync(root);
    // A folder another account owns, or one others may write into, could be
    // filled with links or files the human never chose.
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o022) !== 0) {
      return {
        ok: false,
        error: makeError("invalid_request", "the upload folder must be a folder you own that others cannot write to", false, { uploadDirectory }),
      };
    }
  } catch {
    return { ok: false, error: makeError("invalid_request", "the upload folder does not exist", false, { uploadDirectory }) };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: makeError("invalid_request", "`files` must be a non-empty array of paths", false) };
  }
  // One answer for "outside the folder", "does not exist" and "not a file":
  // a caller must not be able to probe what exists elsewhere on the machine.
  const refused = (): { ok: false; error: ErrorPayload } => ({
    ok: false,
    error: makeError(
      "invalid_request",
      "cannot attach files: each path must be an existing file inside the upload folder",
      false,
      { uploadDirectory: root },
    ),
  });
  const resolved: string[] = [];
  for (const entry of files) {
    if (typeof entry !== "string" || !isAbsolute(entry)) return refused();
    try {
      const real = realpathSync(entry);
      if (!real.startsWith(root + sep) || !statSync(real).isFile()) return refused();
      resolved.push(real);
    } catch {
      return refused();
    }
  }
  return { ok: true, files: resolved };
}

interface PendingCommand {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

class ExtensionPeer {
  readonly sessionId: string;
  readonly connectedAt: number;
  readonly remoteAddress: string;
  hello: ClientHello | null = null;
  /** Handshake progress (ADR 0005). Only `done` peers may carry requests. */
  stage: "hello" | "proving" | "auth" | "verifying" | "done" = "hello";
  clientNonce = "";
  serverNonce = "";
  lastSeenAt: number;
  /** Set when this peer was refused, so the close handler reports the real cause. */
  rejection: ErrorPayload | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private closed = false;

  constructor(
    readonly socket: WebSocket,
    remoteAddress: string,
    private readonly logger: Logger,
  ) {
    this.sessionId = randomUUID();
    this.connectedAt = Date.now();
    this.lastSeenAt = this.connectedAt;
    this.remoteAddress = remoteAddress;
  }

  attachHello(hello: ClientHello): void {
    this.hello = hello;
  }

  touch(): void {
    this.lastSeenAt = Date.now();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  send(payload: unknown): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  request(method: string, params: JsonObject | undefined, timeoutMs: number): Promise<JsonValue> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("extension_disconnected"));
    }
    const id = randomUUID();
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const envelope: RequestEnvelope = { id, method };
      if (params !== undefined) envelope.params = params;
      this.send(envelope);
    });
  }

  settle(id: string, payload: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) {
      this.logger.warn("response for unknown request id", { id });
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (!isResponseEnvelope(payload)) {
      entry.reject(new Error("invalid_response"));
      return;
    }
    if (payload.ok) entry.resolve(payload.result);
    else entry.reject(Object.assign(new Error(payload.error.message), { payload: payload.error }));
  }

  failAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(reason), { inFlightMethod: entry.method, requestId: id }));
    }
    this.pending.clear();
  }

  close(code: number, reason: string): void {
    this.closed = true;
    this.failAll("extension_disconnected");
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  markClosed(): void {
    this.closed = true;
    this.failAll("extension_disconnected");
  }
}

export interface Bridge {
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
  health(): Promise<BridgeHealth>;
  requestExtension(method: string, params?: JsonObject, timeoutMs?: number): Promise<JsonValue>;
  readonly currentSessionId: () => string | null;
}

export function createBridge(options: BridgeOptions): Bridge {
  const logger = options.logger.child("bridge");
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const healthTimeoutMs = options.healthTimeoutMs ?? 1_500;
  const allowedExtensionIds = options.allowedExtensionIds ?? [];
  const tokenFingerprint = fingerprint(options.token);

  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const startedAt = Date.now();
  let activePeer: ExtensionPeer | null = null;
  let socketsSeen = 0;
  let listeningPort = 0;
  /** The address the server actually bound, read back from the listener. */
  let listeningHost = BIND_HOST;
  let lastDisconnectError: ErrorPayload | undefined;
  let lastRejectedHandshake: { at: string; error: ErrorPayload } | undefined;
  const rpcNonces = new Map<string, { clientNonce: string; expiresAt: number }>();
  const uploadDirectory = options.uploadDirectory;
  let heartbeat: NodeJS.Timeout | null = null;

  const pendingConnections = new Set<ExtensionPeer>();

  function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    // One response per request, whoever gets there first. Without this a second
    // writer (a late `end` after the 413 path, or a timeout racing a reply)
    // throws ERR_HTTP_HEADERS_SENT inside an event handler, which on the CLI's
    // single-threaded path takes the bridge down with it.
    if (res.headersSent || res.writableEnded) return;
    writeRaw(res, status, JSON.stringify(body), extraHeaders);
  }

  function writeRaw(res: ServerResponse, status: number, payload: string, extraHeaders: Record<string, string> = {}): void {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
      ...extraHeaders,
    });
    res.end(payload);
  }

  /**
   * An `/rpc` answer carries its own proof, bound to the nonce the caller was
   * issued and the exact bytes of the body, so the caller can tell the real
   * bridge's answer from one invented by whatever else might hold the port.
   */
  async function writeSignedJson(res: ServerResponse, status: number, body: unknown, serverNonce: string): Promise<void> {
    const payload = JSON.stringify(body);
    const proof = await makeProof(options.token, PROOF_LABELS.rpcResponse, [serverNonce, await sha256Hex(payload)]);
    writeRaw(res, status, payload, { [RPC_RESPONSE_PROOF_HEADER]: proof });
  }

  /**
   * Which side is older, when both carry a parseable timestamp. Null when the
   * order cannot be established, in which case the diagnosis names both builds
   * rather than guessing.
   */
  function olderSide(
    extension: { build: string; builtAt: string | null },
    bridge: { build: string; builtAt: string },
  ): "extension" | "bridge" | null {
    if (extension.builtAt === null) return null;
    const extensionTime = Date.parse(extension.builtAt);
    const bridgeTime = Date.parse(bridge.builtAt);
    if (Number.isNaN(extensionTime) || Number.isNaN(bridgeTime) || extensionTime === bridgeTime) return null;
    return extensionTime < bridgeTime ? "extension" : "bridge";
  }

  /**
   * Turn `unknown_method` / `not_implemented` into the diagnosis a caller can act
   * on.
   *
   * The extension bakes its build id into the error detail. When that id is not
   * this bridge's build id, the method is not missing from the code — one of the
   * two sides is stale. Which one is decided from the build timestamps when they
   * are both present: a rebuilt unpacked extension keeps the worker script Chrome
   * cached at its last load, while a bridge process keeps the bundle it started
   * with. Blaming the extension unconditionally (the first cut of this change) was
   * wrong for the long-lived-bridge workflow, where the bridge is the older side.
   *
   * A same-build answer is explicitly not called stale: for `unknown_method` that
   * means a real code bug; for `not_implemented` it means the method is genuinely
   * reserved-but-unbuilt in this build.
   */
  function withStaleBuildDiagnosis(payload: ErrorPayload): ErrorPayload {
    if (payload.code !== "unknown_method" && payload.code !== "not_implemented") return payload;
    const detail = isPlainObject(payload.detail) ? payload.detail : {};
    const reportedBuild = detail["extensionBuild"];
    const reportedAt = detail["extensionBuiltAt"];
    // The same bound the hello gets: these strings are quoted into the message.
    const extensionBuild = isBuildLabel(reportedBuild) ? reportedBuild : (activePeer?.hello?.client.build ?? null);
    const extensionBuiltAt = isBuildLabel(reportedAt) ? reportedAt : (activePeer?.hello?.client.builtAt ?? null);

    let hint: string;
    let older: "extension" | "bridge" | null = null;
    if (extensionBuild === null) {
      hint = `the extension reported no build id, so it predates build stamping — ${RELOAD_EXTENSION_HINT}`;
    } else if (extensionBuild === BUILD_ID) {
      hint =
        payload.code === "unknown_method"
          ? `the extension and this bridge report the same build (${BUILD_ID}); this is not a stale-build symptom — the method really is unknown to the code that answered`
          : `the extension and this bridge report the same build (${BUILD_ID}); the method is reserved-but-unbuilt in this build — not a stale-build symptom`;
    } else {
      older = olderSide(
        { build: extensionBuild, builtAt: extensionBuiltAt },
        { build: BUILD_ID, builtAt: BUILT_AT },
      );
      const extensionLabel = `${extensionBuild}${extensionBuiltAt === null ? "" : `, built ${extensionBuiltAt}`}`;
      const bridgeLabel = `${BUILD_ID}${BUILT_AT === "unknown" ? "" : `, built ${BUILT_AT}`}`;
      hint =
        older === "extension"
          ? `the running extension was built earlier (${extensionLabel}) than this bridge (${bridgeLabel}) — the extension is stale: ${RELOAD_EXTENSION_HINT}`
          : older === "bridge"
            ? `this bridge was built earlier (${bridgeLabel}) than the running extension (${extensionLabel}) — the bridge is stale: ${RESTART_BRIDGE_HINT}`
            : `the running extension (${extensionLabel}) and this bridge (${bridgeLabel}) were not built together — one side is stale: ${RELOAD_EXTENSION_HINT}, and ${RESTART_BRIDGE_HINT} if the extension is not the older side`;
    }

    // Reserve the hint's space before truncating the original message: a cut
    // diagnosis is the failure this whole path exists to prevent.
    const separator = " — ";
    const room = Math.max(0, MAX_MESSAGE_LENGTH - hint.length - separator.length);
    return {
      code: payload.code,
      message: `${payload.message.slice(0, room)}${separator}${hint}`.slice(0, MAX_MESSAGE_LENGTH),
      retryable: payload.retryable,
      detail: {
        ...detail,
        hint,
        extensionBuild,
        extensionBuiltAt,
        bridgeBuild: BUILD_ID,
        bridgeBuiltAt: BUILT_AT,
        olderSide: older,
      },
    };
  }

  /**
   * A forwarded command can fail two ways: the extension answered with an error
   * envelope (which carries a `payload`), or the bridge itself gave up (a
   * `timeout`, `invalid_response` or a dropped socket). Both must report their
   * own code — a slow extension is not a disconnected one, and `/health` would
   * contradict the error if we collapsed them.
   */
  function commandFailure(error: unknown): ErrorPayload {
    const candidate = isPlainObject(error) ? error["payload"] : undefined;
    if (isErrorPayload(candidate)) return withStaleBuildDiagnosis(candidate);
    const message = error instanceof Error ? error.message : "";
    if (message === "timeout") return makeError("timeout", "the extension did not answer in time");
    if (message === "invalid_response") return makeError("internal", "the extension sent a malformed response");
    if (message === "extension_disconnected") return makeError("extension_disconnected", "the extension is not connected");
    return makeError("internal", "the command failed");
  }

  function purgeExpiredNonces(now: number): void {
    for (const [nonce, entry] of rpcNonces) if (entry.expiresAt <= now) rpcNonces.delete(nonce);
  }

  function headerValue(req: IncomingMessage, name: string): string | undefined {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" ? value.trim() : undefined;
  }

  function readBody(req: IncomingMessage, res: ServerResponse, limit: number, onBody: (text: string) => void): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let responded = false;
    req.on("data", (chunk: Buffer) => {
      if (responded) return;
      size += chunk.length;
      if (size > limit) {
        responded = true;
        writeJson(res, 413, { ok: false, error: makeError("invalid_request", "request body too large") });
        // Drain rather than destroy: destroying on this tick can truncate the
        // 413 we just wrote.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (responded) return;
      responded = true;
      onBody(Buffer.concat(chunks).toString("utf8"));
    });
  }

  /**
   * Step one of an `/rpc` call: the caller sends a fresh nonce, the bridge answers
   * with its own nonce and a proof that it holds the token. A caller that cannot
   * verify the proof is talking to something else and must not send the request.
   */
  function handleChallenge(req: IncomingMessage, res: ServerResponse): void {
    readBody(req, res, MAX_CHALLENGE_BODY_BYTES, (text) => {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        writeJson(res, 400, { ok: false, error: makeError("invalid_request", "body must be JSON") });
        return;
      }
      const clientNonce = isPlainObject(body) ? body["clientNonce"] : undefined;
      if (!isNonce(clientNonce)) {
        writeJson(res, 400, { ok: false, error: makeError("invalid_request", "clientNonce must be a 32-byte base64url nonce") });
        return;
      }
      const now = Date.now();
      purgeExpiredNonces(now);
      while (rpcNonces.size >= MAX_OUTSTANDING_RPC_NONCES) {
        // Map iteration order is insertion order: the first key is the oldest.
        const oldest = rpcNonces.keys().next().value;
        if (oldest === undefined) break;
        rpcNonces.delete(oldest);
      }
      const serverNonce = newNonce();
      rpcNonces.set(serverNonce, { clientNonce, expiresAt: now + RPC_NONCE_TTL_MS });
      void makeProof(options.token, PROOF_LABELS.rpcServer, [clientNonce, serverNonce]).then((serverProof) =>
        writeJson(res, 200, { ok: true, serverNonce, serverProof }),
      );
    });
  }

  function forward(method: string, params?: JsonObject, timeoutMs?: number): Promise<JsonValue> {
    const peer = activePeer;
    if (!peer || peer.isClosed) {
      return Promise.reject(
        Object.assign(new Error("extension_disconnected"), {
          payload: makeError("extension_disconnected", "the extension is not connected", false),
        }),
      );
    }
    return peer.request(method, params, timeoutMs ?? requestTimeoutMs);
  }

  function healthView(includeExtensionHealth: boolean): Promise<BridgeHealth> {
    const bridgeBuild: BuildView = { id: BUILD_ID, builtAt: BUILT_AT };
    const base: BridgeHealth = {
      ok: true,
      build: { bridge: bridgeBuild, extension: null, mismatch: null },
      bridge: {
        name: BRIDGE_PRODUCT_NAME,
        version: BRIDGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        host: listeningHost,
        port: listeningPort,
        startedAt: new Date(startedAt).toISOString(),
        uptimeMs: Date.now() - startedAt,
        tokenConfigured: options.token.length > 0,
        tokenFingerprint,
        allowedExtensionIds,
        socketsSeen,
        uploadDirectory: uploadDirectory ?? null,
      },
      extension: { connected: false },
    };
    if (lastRejectedHandshake !== undefined) base.bridge.lastRejectedHandshake = lastRejectedHandshake;
    const peer = activePeer;
    if (!peer || peer.hello === null || peer.isClosed) {
      base.extension = lastDisconnectError
        ? { connected: false, lastError: lastDisconnectError }
        : { connected: false };
      return Promise.resolve(base);
    }
    const hello = peer.hello;
    // The extension's own stamp travels in its hello, and in every `health`
    // payload; the hello one is what /health can report even when the worker is
    // too busy to answer. Missing means the extension predates build stamping.
    const extensionBuild: BuildView | null =
      typeof hello.client.build === "string"
        ? { id: hello.client.build, builtAt: hello.client.builtAt ?? null }
        : null;
    base.build = {
      bridge: bridgeBuild,
      extension: extensionBuild,
      mismatch: extensionBuild === null ? null : extensionBuild.id !== BUILD_ID,
    };
    const view: ExtensionHealthView = {
      connected: true,
      sessionId: peer.sessionId,
      connectedAt: new Date(peer.connectedAt).toISOString(),
      connectedForMs: Date.now() - peer.connectedAt,
      lastSeenAgoMs: Date.now() - peer.lastSeenAt,
      remoteAddress: peer.remoteAddress,
      client: hello.client,
      health: null,
    };
    base.extension = view;
    if (!includeExtensionHealth) return Promise.resolve(base);
    return peer
      .request("health", undefined, healthTimeoutMs)
      .then((result) => {
        view.health = result;
        return base;
      })
      .catch((error: unknown) => {
        view.healthError =
          error instanceof Error && "payload" in error && isPlainObject((error as { payload?: unknown }).payload)
            ? ((error as { payload: ErrorPayload }).payload)
            : makeError("timeout", "extension did not answer health in time", true);
        return base;
      });
  }

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const remote = req.socket.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      writeJson(res, 403, { ok: false, error: makeError("unauthorized", "loopback clients only") });
      return;
    }
    if (!isAllowedHost(req.headers.host, listeningPort)) {
      logger.warn("rejected unexpected Host on the http surface", { host: req.headers.host?.slice(0, 120) });
      writeJson(res, 403, { ok: false, error: makeError("unauthorized", "host is not this bridge") });
      return;
    }
    // Loopback is not a security boundary in a browser: any page the user has
    // open can POST to this port. A browser always sends Origin, so a page is
    // refused here; tools without an Origin (the CLI, Cua) are still allowed.
    if (!isAllowedOrigin(req.headers.origin, allowedExtensionIds)) {
      logger.warn("rejected disallowed origin on the http surface", { origin: req.headers.origin });
      writeJson(res, 403, { ok: false, error: makeError("unauthorized", "origin is not the extension's") });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${BIND_HOST}`);

    if (url.pathname === "/auth/challenge" || url.pathname === "/rpc") {
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        writeJson(res, 405, { ok: false, error: makeError("invalid_request", `use POST for ${url.pathname}`) });
        return;
      }
      // The command surface needs a proof of the per-install token, exactly as the
      // extension socket does (ADR 0005); the token itself is never sent.
      // `/health` and `/version` stay open so a human can diagnose with curl; they
      // change nothing and carry no browsing detail.
      if (url.pathname === "/auth/challenge") handleChallenge(req, res);
      else handleRpc(req, res);
      return;
    }

    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      writeJson(res, 405, { ok: false, error: makeError("invalid_request", "only GET is supported") });
      return;
    }
    if (url.pathname === "/health") {
      // Bridge state only. The extension's own health includes its recent audit
      // trail and any open dialog text, so it is served to authenticated callers
      // only (`/rpc` method `health`).
      void healthView(false).then((body) => writeJson(res, 200, body));
      return;
    }
    if (url.pathname === "/version") {
      writeJson(res, 200, {
        name: BRIDGE_PRODUCT_NAME,
        version: BRIDGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        build: BUILD_ID,
        builtAt: BUILT_AT,
      });
      return;
    }
    writeJson(res, 404, { ok: false, error: makeError("not_found", `no route for ${url.pathname}`) });
  }

  /**
   * The narrow tool surface for a local caller (the CLI today, Cua in M4).
   * It forwards one method to the extension, unchanged, and returns the same
   * envelope. No retries, no defaulting: unknown or unbuilt methods fail closed.
   */
  function handleRpc(req: IncomingMessage, res: ServerResponse): void {
    const serverNonce = headerValue(req, RPC_NONCE_HEADER);
    const proof = headerValue(req, RPC_PROOF_HEADER);
    const unauthorised = (): void => {
      writeJson(res, 401, {
        ok: false,
        error: makeError("unauthorized", "a fresh token proof is required on /rpc (POST /auth/challenge first)"),
      });
    };
    readBody(req, res, MAX_RPC_BODY_BYTES, (text) => {
      void (async () => {
        purgeExpiredNonces(Date.now());
        const issued = serverNonce !== undefined ? rpcNonces.get(serverNonce) : undefined;
        // Single use, spent whether or not the proof checks out: a nonce is never
        // a second chance.
        if (serverNonce !== undefined) rpcNonces.delete(serverNonce);
        if (serverNonce === undefined || issued === undefined) {
          unauthorised();
          return;
        }
        if (!(await verifyProof(options.token, PROOF_LABELS.rpcClient, [serverNonce, await sha256Hex(text)], proof))) {
          logger.warn("rejected /rpc: proof mismatch");
          unauthorised();
          return;
        }
        const reply = (status: number, body: unknown): void => {
          void writeSignedJson(res, status, body, serverNonce);
        };
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          reply(400, { ok: false, error: makeError("invalid_request", "body must be JSON") });
          return;
        }
        const parsed = parseRequestEnvelope(body);
        if (!parsed.ok) {
          reply(400, { ok: false, error: parsed.error });
          return;
        }
        const envelope = parsed.value;
        if (!isV1Method(envelope.method)) {
          // A stale bridge rejected the method before the extension ever saw it, so
          // there is no extension stamp to report — stamp the bridge's own build
          // instead, or the original bug is reproduced with no evidence.
          reply(400, {
            ok: false,
            error: makeError("unknown_method", `unknown method: ${envelope.method}`, false, {
              bridgeBuild: BUILD_ID,
              bridgeBuiltAt: BUILT_AT,
              hint: `this bridge (${BUILD_ID}) does not know the method — if a newer client expects it, the bridge is stale: ${RESTART_BRIDGE_HINT}`,
            }),
          });
          return;
        }
        let params = envelope.params;
        if (envelope.method === "page.upload" && params !== undefined) {
          // The bridge, not the extension, owns the filesystem check: it is the
          // only side that can resolve symlinks on this machine.
          const files = resolveUploadPaths(params["files"], uploadDirectory);
          if (!files.ok) {
            reply(200, errorResponse(envelope.id, files.error));
            return;
          }
          params = { ...params, files: files.files };
        }
        const timeout = LONG_RUNNING_METHODS.has(envelope.method) ? LONG_RUNNING_TIMEOUT_MS : undefined;
        forward(envelope.method, params, timeout)
          .then((result) => reply(200, okResponse(envelope.id, result)))
          .catch((error: unknown) => {
            reply(200, errorResponse(envelope.id, commandFailure(error)));
          });
      })();
    });
  }

  function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socketsSeen += 1;
    const remote = req.socket.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      logger.warn("rejected non-loopback upgrade", { remote });
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (!isAllowedHost(req.headers.host, listeningPort)) {
      logger.warn("rejected upgrade: unexpected Host", { host: req.headers.host?.slice(0, 120) });
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (pendingConnections.size >= MAX_PENDING_CONNECTIONS) {
      // Evict the oldest socket still mid-handshake (Set order is insertion order).
      const oldest = pendingConnections.values().next().value;
      if (oldest !== undefined) {
        logger.warn("evicting the oldest socket mid-handshake", { pending: pendingConnections.size, sessionId: oldest.sessionId });
        pendingConnections.delete(oldest);
        oldest.close(WS_CLOSE.handshakeTimeout, "evicted");
      }
    }
    const url = new URL(req.url ?? "/", `http://${BIND_HOST}`);
    if (url.pathname !== EXTENSION_PATH) {
      logger.warn("rejected upgrade: wrong path", { path: url.pathname });
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, allowedExtensionIds)) {
      logger.warn("rejected disallowed origin", { origin });
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSocket(ws, remote ?? "unknown");
    });
  }

  function attachSocket(ws: WebSocket, remoteAddress: string): void {
    const peer = new ExtensionPeer(ws, remoteAddress, logger);
    pendingConnections.add(peer);
    /**
     * A refusal before the peer proved the token. Any local process can cause
     * one, so it is reported apart from the authenticated session's own errors
     * and can never overwrite them (ADR 0005).
     */
    const refuse = (error: ErrorPayload, closeCode: number, reason: string, sendError: boolean): void => {
      peer.rejection = error;
      lastRejectedHandshake = { at: new Date().toISOString(), error };
      if (sendError) peer.send({ type: "hello_error", error });
      peer.close(closeCode, reason);
    };
    const handshakeTimer = setTimeout(() => {
      if (peer.stage === "done") return;
      logger.warn("handshake timeout", { sessionId: peer.sessionId, stage: peer.stage });
      refuse(makeError("timeout", "the extension did not complete the handshake in time"), WS_CLOSE.handshakeTimeout, "handshake timeout", false);
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("pong", () => peer.touch());
    ws.on("message", (data: Buffer) => {
      peer.touch();
      if (peer.stage !== "done" && data.length > MAX_PREAUTH_FRAME_BYTES) {
        logger.warn("pre-auth frame too large", { bytes: data.length });
        refuse(makeError("invalid_request", "handshake frame too large"), WS_CLOSE.malformed, "frame too large", false);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        logger.warn("malformed JSON frame");
        if (peer.stage !== "done") refuse(makeError("invalid_request", "malformed json"), WS_CLOSE.malformed, "malformed json", false);
        else peer.close(WS_CLOSE.malformed, "malformed json");
        return;
      }

      if (peer.stage === "hello") {
        if (!isClientHello(parsed)) {
          refuse(makeError("invalid_request", "expected hello"), WS_CLOSE.malformed, "expected hello", true);
          return;
        }
        if (parsed.protocolVersion !== PROTOCOL_VERSION) {
          logger.warn("protocol mismatch", { peer: parsed.protocolVersion, bridge: PROTOCOL_VERSION });
          refuse(makeError("protocol_mismatch", `protocol ${PROTOCOL_VERSION} required`), WS_CLOSE.protocolMismatch, "protocol mismatch", true);
          return;
        }
        // The bridge proves itself first, so a client never hands anything
        // token-derived to whatever else might be answering on this port.
        peer.stage = "proving";
        peer.attachHello(parsed);
        peer.clientNonce = parsed.clientNonce;
        peer.serverNonce = newNonce();
        void makeProof(options.token, PROOF_LABELS.wsServer, [peer.clientNonce, peer.serverNonce]).then((serverProof) => {
          if (peer.isClosed) return;
          peer.stage = "auth";
          peer.send({ type: "hello_challenge", serverNonce: peer.serverNonce, serverProof });
        });
        return;
      }

      if (peer.stage === "auth") {
        if (!isClientAuth(parsed)) {
          refuse(makeError("invalid_request", "expected hello_auth"), WS_CLOSE.malformed, "expected hello_auth", true);
          return;
        }
        peer.stage = "verifying";
        void verifyProof(options.token, PROOF_LABELS.wsClient, [peer.clientNonce, peer.serverNonce], parsed.clientProof).then((valid) => {
          if (peer.isClosed) return;
          if (!valid) {
            logger.warn("rejected hello: client proof mismatch", { expectedFingerprint: tokenFingerprint });
            refuse(makeError("unauthorized", "token rejected"), WS_CLOSE.unauthorized, "unauthorized", true);
            return;
          }
          clearTimeout(handshakeTimer);
          peer.stage = "done";
          const previous = activePeer;
          if (previous && !previous.isClosed) {
            logger.info("replacing existing extension connection", { replacedSession: previous.sessionId });
            previous.close(WS_CLOSE.replaced, "replaced_by_new_connection");
          }
          pendingConnections.delete(peer);
          activePeer = peer;
          lastDisconnectError = undefined;
          peer.send({
            type: "hello_ok",
            protocolVersion: PROTOCOL_VERSION,
            sessionId: peer.sessionId,
            server: { name: BRIDGE_PRODUCT_NAME, version: BRIDGE_VERSION },
          });
          const hello = peer.hello;
          logger.info("extension connected", {
            sessionId: peer.sessionId,
            extensionId: hello?.client.extensionId,
            extensionVersion: hello?.client.version,
            extensionBuild: hello?.client.build ?? null,
            resumed: hello?.client.resumed ?? false,
            tokenFingerprint,
          });
          // A build mismatch is the signature of a stale unpacked extension. It is
          // logged only once the peer has proved the token (ADR 0005): before that,
          // its claimed build is just something an impostor could say.
          if (hello?.client.build !== undefined && hello.client.build !== BUILD_ID) {
            logger.warn("extension build differs from bridge build: one side is stale", {
              extensionBuild: hello.client.build,
              extensionBuiltAt: hello.client.builtAt ?? null,
              bridgeBuild: BUILD_ID,
              bridgeBuiltAt: BUILT_AT,
              olderSide: olderSide(
                { build: hello.client.build, builtAt: hello.client.builtAt ?? null },
                { build: BUILD_ID, builtAt: BUILT_AT },
              ),
              hint: `reload the unpacked extension and/or ${RESTART_BRIDGE_HINT}, whichever is older`,
            });
          }
        });
        return;
      }

      if (peer.stage !== "done") {
        // A frame while a proof is being computed or checked: the peer did not
        // wait for its turn. Nothing it sends before `hello_ok` is acted on.
        refuse(makeError("invalid_request", "frame sent before the handshake completed"), WS_CLOSE.malformed, "out of turn", false);
        return;
      }

      if (isControlFrame(parsed)) {
        if (parsed.type === "ping") peer.send({ type: "pong", seq: parsed.seq });
        return;
      }

      if (isPlainObject(parsed) && typeof parsed["method"] === "string") {
        handlePeerRequest(peer, parsed);
        return;
      }

      if (isPlainObject(parsed) && typeof parsed["id"] === "string") {
        peer.settle(parsed["id"], parsed);
        return;
      }

      logger.warn("unrecognised frame from extension");
    });

    ws.on("close", (code, reason) => {
      clearTimeout(handshakeTimer);
      pendingConnections.delete(peer);
      peer.markClosed();
      // A peer that was replaced (4009) or that never authenticated must not
      // overwrite the reason the operator needs to see. Rejections already
      // recorded their own reason when they happened.
      const wasActive = activePeer === peer;
      if (wasActive) activePeer = null;
      if (code !== 1000 && code !== 1005) {
        if (wasActive) {
          lastDisconnectError = makeError("extension_disconnected", `extension socket closed (${code})`);
        }
        logger.warn("extension disconnected", {
          sessionId: peer.sessionId,
          code,
          reason: reason.toString().slice(0, 120),
        });
      } else {
        logger.info("extension socket closed", { sessionId: peer.sessionId, code });
      }
    });

    ws.on("error", (error: Error) => {
      logger.warn("extension socket error", { sessionId: peer.sessionId, error: error.message });
    });
  }

  function handlePeerRequest(peer: ExtensionPeer, raw: Record<string, unknown>): void {
    const parsed = parseRequestEnvelope(raw);
    if (!parsed.ok) {
      const id = typeof raw["id"] === "string" ? raw["id"] : "";
      peer.send(errorResponse(id, parsed.error));
      return;
    }
    const envelope = parsed.value;
    if (envelope.method === "health") {
      // Bridge-side health without recursion back into the extension.
      void healthView(false).then((body) =>
        peer.send(okResponse(envelope.id, { bridge: body.bridge, extension: { connected: true } } as unknown as JsonValue)),
      );
      return;
    }
    peer.send(
      errorResponse(
        envelope.id,
        makeError("unknown_method", `unknown method: ${envelope.method}`, false, {
          bridgeBuild: BUILD_ID,
          bridgeBuiltAt: BUILT_AT,
        }),
      ),
    );
  }

  return {
    async start() {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(options.port, BIND_HOST);
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("bridge failed to bind a TCP port");
      listeningPort = address.port;
      listeningHost = address.address;
      httpServer.on("request", handleHttp);
      httpServer.on("upgrade", handleUpgrade);
      heartbeat = setInterval(() => {
        for (const peer of [activePeer, ...pendingConnections]) {
          if (!peer) continue;
          if (Date.now() - peer.lastSeenAt > PEER_PING_INTERVAL_MS + PEER_DEAD_AFTER_MS) {
            logger.warn("peer went silent; terminating", { sessionId: peer.sessionId });
            peer.socket.terminate();
            continue;
          }
          try {
            peer.socket.ping();
          } catch {
            // Socket already closing; the close handler cleans up.
          }
        }
      }, PEER_PING_INTERVAL_MS);
      heartbeat.unref?.();
      logger.info("bridge listening", {
        host: BIND_HOST,
        port: listeningPort,
        protocolVersion: PROTOCOL_VERSION,
        tokenFingerprint,
        allowedExtensionIds,
      });
      return { host: listeningHost, port: listeningPort };
    },

    async stop() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      const peers = [activePeer, ...pendingConnections].filter((peer): peer is ExtensionPeer => peer !== null);
      activePeer = null;
      const closed = new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      for (const peer of peers) {
        peer.close(1001, "bridge_stopping");
        // ws waits for the client's close reply, up to its own 30 s close
        // timeout. A half-open extension would hold SIGTERM for that long, so
        // the socket is ended here rather than waited on.
        peer.socket.terminate();
      }
      httpServer.closeAllConnections?.();
      await Promise.all([
        closed,
        new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        }),
      ]);
    },

    health() {
      return healthView(true);
    },

    requestExtension(method: string, params?: JsonObject, timeoutMs?: number) {
      return forward(method, params, timeoutMs);
    },

    currentSessionId() {
      const peer = activePeer;
      if (!peer || peer.isClosed) return null;
      return peer.sessionId;
    },
  };
}

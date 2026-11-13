/**
 * The loopback bridge.
 *
 * Responsibilities in M0:
 *   - bind 127.0.0.1 only (never a wildcard address);
 *   - accept exactly one authenticated extension socket, rejecting any other
 *     origin (a web page cannot connect just because it guessed the port);
 *   - perform the v1 hello handshake with the per-install token;
 *   - answer `GET /health` with the bridge's own state *and* the extension's
 *     forwarded health, so "is Ava's browser path alive?" has a single answer;
 *   - fail in-flight commands loudly when the socket drops. Never retried here;
 *     `page.click` and `page.type` are not idempotent (AGENTS.md rule 5).
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_PRODUCT_NAME,
  HANDSHAKE_TIMEOUT_MS,
  isV1Method,
  PROTOCOL_VERSION,
  WS_CLOSE,
  errorResponse,
  isClientHello,
  isControlFrame,
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

export interface BridgeOptions {
  port: number;
  token: string;
  allowedExtensionIds?: string[];
  logger: Logger;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface BridgeHealth {
  ok: true;
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

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Header a local tool may use instead of `Authorization: Bearer`. */
export const TOKEN_HEADER = "x-ava-token";
export const MAX_RPC_BODY_BYTES = 256_000;

/**
 * The token a local HTTP caller presented, if any. Both spellings are accepted
 * because `curl -H` with a bearer header and a bare custom header are equally
 * common in runbooks; neither is ever logged.
 */
export function presentedToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (bearer?.[1] !== undefined) {
      const value = bearer[1].trim();
      if (value.length > 0) return value;
    }
  }
  const header = req.headers[TOKEN_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
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
  let heartbeat: NodeJS.Timeout | null = null;

  const pendingConnections = new Set<ExtensionPeer>();

  function writeJson(res: ServerResponse, status: number, body: unknown): void {
    // One response per request, whoever gets there first. Without this a second
    // writer (a late `end` after the 413 path, or a timeout racing a reply)
    // throws ERR_HTTP_HEADERS_SENT inside an event handler, which on the CLI's
    // single-threaded path takes the bridge down with it.
    if (res.headersSent || res.writableEnded) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    res.end(payload);
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
    if (isErrorPayload(candidate)) return candidate;
    const message = error instanceof Error ? error.message : "";
    if (message === "timeout") return makeError("timeout", "the extension did not answer in time");
    if (message === "invalid_response") return makeError("internal", "the extension sent a malformed response");
    if (message === "extension_disconnected") return makeError("extension_disconnected", "the extension is not connected");
    return makeError("internal", "the command failed");
  }

  function httpAuthorised(req: IncomingMessage): boolean {
    const provided = presentedToken(req);
    return provided !== null && tokensMatch(provided, options.token);
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
    const base: BridgeHealth = {
      ok: true,
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
      },
      extension: { connected: false },
    };
    const peer = activePeer;
    if (!peer || peer.hello === null || peer.isClosed) {
      base.extension = lastDisconnectError
        ? { connected: false, lastError: lastDisconnectError }
        : { connected: false };
      return Promise.resolve(base);
    }
    const hello = peer.hello;
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
    // Loopback is not a security boundary in a browser: any page the user has
    // open can POST to this port. A browser always sends Origin, so a page is
    // refused here; tools without an Origin (the CLI, Cua) are still allowed.
    if (!isAllowedOrigin(req.headers.origin, allowedExtensionIds)) {
      logger.warn("rejected disallowed origin on the http surface", { origin: req.headers.origin });
      writeJson(res, 403, { ok: false, error: makeError("unauthorized", "origin is not the extension's") });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${BIND_HOST}`);

    if (url.pathname === "/rpc") {
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        writeJson(res, 405, { ok: false, error: makeError("invalid_request", "use POST for /rpc") });
        return;
      }
      // The command surface carries the per-install token, exactly as the
      // extension socket does. `/health` and `/version` stay open so a human can
      // diagnose with curl; they cannot change anything.
      if (!httpAuthorised(req)) {
        res.setHeader("www-authenticate", "Bearer");
        writeJson(res, 401, { ok: false, error: makeError("unauthorized", "the bridge token is required on /rpc") });
        return;
      }
      handleRpc(req, res);
      return;
    }

    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      writeJson(res, 405, { ok: false, error: makeError("invalid_request", "only GET is supported") });
      return;
    }
    if (url.pathname === "/health") {
      void healthView(true).then((body) => writeJson(res, 200, body));
      return;
    }
    if (url.pathname === "/version") {
      writeJson(res, 200, { name: BRIDGE_PRODUCT_NAME, version: BRIDGE_VERSION, protocolVersion: PROTOCOL_VERSION });
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
    const chunks: Buffer[] = [];
    let size = 0;
    let responded = false;
    req.on("data", (chunk: Buffer) => {
      if (responded) return;
      size += chunk.length;
      if (size > MAX_RPC_BODY_BYTES) {
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
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        writeJson(res, 400, { ok: false, error: makeError("invalid_request", "body must be JSON") });
        return;
      }
      const parsed = parseRequestEnvelope(body);
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error });
        return;
      }
      const envelope = parsed.value;
      if (!isV1Method(envelope.method)) {
        writeJson(res, 400, { ok: false, error: makeError("unknown_method", `unknown method: ${envelope.method}`) });
        return;
      }
      const timeout = LONG_RUNNING_METHODS.has(envelope.method) ? LONG_RUNNING_TIMEOUT_MS : undefined;
      forward(envelope.method, envelope.params, timeout)
        .then((result) => writeJson(res, 200, okResponse(envelope.id, result)))
        .catch((error: unknown) => {
          writeJson(res, 200, errorResponse(envelope.id, commandFailure(error)));
        });
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
    let authenticated = false;
    const handshakeTimer = setTimeout(() => {
      if (authenticated) return;
      logger.warn("handshake timeout", { sessionId: peer.sessionId });
      peer.rejection = makeError("timeout", "the extension did not complete the handshake in time");
      lastDisconnectError = peer.rejection;
      peer.close(WS_CLOSE.handshakeTimeout, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("pong", () => peer.touch());
    ws.on("message", (data: Buffer) => {
      peer.touch();
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        logger.warn("malformed JSON frame");
        peer.close(WS_CLOSE.malformed, "malformed json");
        return;
      }

      if (!authenticated) {
        if (!isClientHello(parsed)) {
          peer.send({ type: "hello_error", error: makeError("invalid_request", "expected hello") });
          peer.close(WS_CLOSE.malformed, "expected hello");
          return;
        }
        authenticated = true;
        clearTimeout(handshakeTimer);
        if (parsed.protocolVersion !== PROTOCOL_VERSION) {
          logger.warn("protocol mismatch", {
            peer: parsed.protocolVersion,
            bridge: PROTOCOL_VERSION,
          });
          peer.rejection = makeError("protocol_mismatch", `protocol ${PROTOCOL_VERSION} required`);
          // Recorded now, not in the close handler: /health must not be able to
          // read a half-finished rejection and report `connected:false` with no
          // reason.
          lastDisconnectError = peer.rejection;
          peer.send({ type: "hello_error", error: peer.rejection });
          peer.close(WS_CLOSE.protocolMismatch, "protocol mismatch");
          return;
        }
        if (!tokensMatch(parsed.token, options.token)) {
          logger.warn("rejected hello: token mismatch", {
            providedFingerprint: fingerprint(parsed.token),
            expectedFingerprint: tokenFingerprint,
          });
          peer.rejection = makeError("unauthorized", "token rejected");
          lastDisconnectError = peer.rejection;
          peer.send({ type: "hello_error", error: peer.rejection });
          peer.close(WS_CLOSE.unauthorized, "unauthorized");
          return;
        }
        const previous = activePeer;
        if (previous && !previous.isClosed) {
          logger.info("replacing existing extension connection", { replacedSession: previous.sessionId });
          previous.close(WS_CLOSE.replaced, "replaced_by_new_connection");
        }
        peer.attachHello(parsed);
        pendingConnections.delete(peer);
        activePeer = peer;
        lastDisconnectError = undefined;
        peer.send({
          type: "hello_ok",
          protocolVersion: PROTOCOL_VERSION,
          sessionId: peer.sessionId,
          server: { name: BRIDGE_PRODUCT_NAME, version: BRIDGE_VERSION },
        });
        logger.info("extension connected", {
          sessionId: peer.sessionId,
          extensionId: parsed.client.extensionId,
          extensionVersion: parsed.client.version,
          resumed: parsed.client.resumed ?? false,
          tokenFingerprint,
        });
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
        peer.send(okResponse(envelope.id, { bridge: body.bridge, extension: { connected: true } } as JsonValue)),
      );
      return;
    }
    peer.send(errorResponse(envelope.id, makeError("unknown_method", `unknown method: ${envelope.method}`)));
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

/**
 * MV3 service worker — the Ava bridge client.
 *
 * Shape of this file: `bootstrap()` builds state, every decision goes through the
 * pure supervisor (`lib/supervisor.ts`) and every side effect is executed by
 * `runEffects`. No business rule lives in an event handler.
 *
 * Keepalive (IMPLEMENTATION-PLAN §3, §9 M0): MV3 workers are suspended after ~30s
 * of inactivity. Two independent keepers keep this one answering:
 *   1. an offscreen document that sends `ava.keepalive.tick` every 20s
 *      (wakes the worker through chrome.runtime messaging);
 *   2. a chrome.alarms heartbeat at the 30s minimum, which survives worker death.
 * A tick either pings the bridge (connected) or re-arms the reconnect loop.
 *
 * The socket lives here, in the worker, because chrome.* APIs only exist here.
 * See docs/adr/0002-socket-ownership-and-keepalive.md for that trade-off.
 */

import {
  PROTOCOL_VERSION,
  PRODUCT_NAME,
  createLogger,
  errorResponse,
  fingerprint,
  isControlFrame,
  isKnownMethod,
  isPlainObject,
  isV1Method,
  isServerChallenge,
  isServerHello,
  makeError,
  makeProof,
  newNonce,
  PROOF_LABELS,
  verifyProof,
  WS_CLOSE,
  okResponse,
  parseActivateParams,
  parseCreateParams,
  parseSessionStatusParams,
  parseCloseParams,
  parseGroupParams,
  parseListParams,
  parseNavigateParams,
  parseClickParams,
  parseDownloadParams,
  parseEvaluateParams,
  parseGetTextParams,
  parseKeyParams,
  parseQueryParams,
  parseReadAxParams,
  parseScreenshotParams,
  parseScrollParams,
  parseSelectParams,
  parseTypeParams,
  parseUploadParams,
  parseWaitForParams,
  parseRequestEnvelope,
  parseSessionEndParams,
  parseSessionStartParams,
  parseUngroupParams,
  type ClientHello,
  type ErrorPayload,
  type JsonObject,
  type JsonValue,
  type LogRecord,
  type Logger,
  type ServerHello,
} from "@gb-ava/protocol";
import { AuditRing, outcomeFor, summariseArgs } from "./lib/audit.js";
import { initialState, reduce, type SupervisorEffect, type SupervisorEvent, type SupervisorState } from "./lib/supervisor.js";
import { CommandError, commandError } from "./lib/errors.js";
import {
  MARKER_GRACE_ALARM,
  MARKER_GRACE_MINUTES,
  initialMarkerState,
  reduceMarker,
  type MarkerEffect,
  type MarkerEvent,
  type MarkerState,
} from "./lib/marker.js";
import { loadMarkerState, saveMarkerState } from "./lib/marker-store.js";
import { attachedTabs, detach, detachAll } from "./lib/debugger.js";
import { clearDialogs, openChoosers, openDialogs, recentDialogs } from "./lib/dialogs.js";
import {
  clickCommand,
  downloadCommand,
  evaluateCommand,
  keyCommand,
  scrollCommand,
  selectCommand,
  typeCommand,
  uploadCommand,
  waitForCommand,
} from "./lib/actions.js";
import {
  bumpDocumentEpoch,
  forgetCapture,
  getTextCommand,
  readAxCommand,
  screenshotCommand,
} from "./lib/read-ops.js";
import {
  activateCommand,
  createCommand,
  closeCommand,
  describeTabsById,
  requireTabs,
  groupCommand,
  listTabsCommand,
  navigateCommand,
  queryTabsCommand,
  readMarkerGroup,
  ungroupCommand,
} from "./lib/tab-ops.js";
import {
  DEFAULT_BRIDGE_URL,
  clearToken,
  bumpWorkerStarts,
  markHandshaked,
  readHasHandshaked,
  readSettings,
  saveSettings,
  setEvaluateEnabled,
  type LoadedSettings,
} from "./lib/settings.js";

const WORKER_STARTED_AT = Date.now();

/** Every command the extension executes, bounded and secret-free (plan §6, M5). */
const audit = new AuditRing();
const ALARM_NAME = "ava.keepalive";
const ALARM_PERIOD_MINUTES = 0.5;
const OFFSCREEN_URL = "offscreen.html";

let workerStarts = 0;
let supervisor: SupervisorState = initialState(WORKER_STARTED_AT);
let settings: LoadedSettings | null = null;
let socket: WebSocket | null = null;
let socketGeneration = 0;
let pingSeq = 0;
let ticksReceived = 0;
/** Ticks that came from the 30 s chrome.alarms heartbeat rather than the offscreen ticker. */
let alarmTicks = 0;
let lastTickAt: number | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastError: string | null = null;
/**
 * Set while the options page itself is saving. Its explicit action is the one
 * that reconnects; this stops the storage listener from reacting to the same
 * write and opening a second socket a moment later.
 */
let selfSaveInFlight = false;

/**
 * The marker (plan §4). Its tab set is authority here, not group membership:
 * the group is a signal for the human and nothing may branch on it.
 */
let marker: MarkerState = initialMarkerState();
/** Diagnostic for the grace path: the last time the marker alarm fired, and what it saw. */
let lastGraceAt: { at: string; connected: boolean; armed: boolean; tabs: number } | null = null;

/**
 * Tabs with a command in flight. Two commands on one tab would interleave input,
 * so the second is refused with `tab_busy` rather than queued (plan §7).
 */
const busyTabs = new Set<number>();

async function withTabLock<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  if (busyTabs.has(tabId)) {
    throw commandError("tab_busy", `tab ${tabId} already has a command in flight`, true);
  }
  busyTabs.add(tabId);
  try {
    return await run();
  } finally {
    busyTabs.delete(tabId);
  }
}

/** The same refusal for a set of tabs: a group touching a busy tab waits. */
async function withTabLocks<T>(tabIds: readonly number[], run: () => Promise<T>): Promise<T> {
  const busy = tabIds.find((id) => busyTabs.has(id));
  if (busy !== undefined) {
    throw commandError("tab_busy", `tab ${busy} already has a command in flight`, true);
  }
  for (const id of tabIds) busyTabs.add(id);
  try {
    return await run();
  } finally {
    for (const id of tabIds) busyTabs.delete(id);
  }
}

/**
 * The group we remember may have been dissolved by the human. Checked before a
 * touch, so the paint path never retries a dead id (and never reports a marker
 * Chrome does not have).
 */
async function ensureMarkerGroupLive(): Promise<void> {
  if (marker.groupId === null || !marker.grouped) return;
  if ((await readMarkerGroup(marker.groupId)) === null) {
    await dispatchMarker({ type: "group_lost", reason: "group_missing" });
  }
}

/**
 * Dispatch one marker event and execute what it asks for.
 *
 * Returns the last failure, or `null` when every effect succeeded. Most callers
 * ignore it — the marker is cosmetic, and failing to paint it must not fail the
 * command that touched the tab. The calls where the marker *is* the command
 * (`tabs.group`) use it so a Chrome refusal is reported instead of a success
 * for a tab the human cannot see marked.
 */
async function dispatchMarker(event: MarkerEvent): Promise<CommandError | null> {
  const { state, effects } = reduceMarker(marker, event);
  marker = state;
  await saveMarkerState(marker);
  return runMarkerEffects(effects);
}

async function runMarkerEffects(effects: readonly MarkerEffect[]): Promise<CommandError | null> {
  let failure: CommandError | null = null;
  for (const effect of effects) {
    switch (effect.type) {
      case "group": {
        try {
          // `effect.groupId` is the marker's own remembered id, not a caller's, so it
          // goes through `rememberedGroupId`: a stale one recovers by creating a group
          // rather than failing the paint. A caller-named id must not recover.
          const result = await groupCommand({ tabIds: effect.tabIds, rememberedGroupId: effect.groupId });
          const groupId = typeof (result as { groupId?: unknown }).groupId === "number" ? (result as { groupId: number }).groupId : null;
          if (groupId !== null) {
            const { state, effects: followUp } = reduceMarker(marker, { type: "grouped", groupId });
            marker = state;
            await saveMarkerState(marker);
            const followUpFailure = await runMarkerEffects(followUp);
            if (followUpFailure !== null) failure = followUpFailure;
          }
        } catch (error) {
          // The marker is cosmetic: failing to paint it must never fail a command.
          // Whoever needed it to succeed is told, through the return value.
          logger.warn("marker group failed", { error: (error as Error).message, tabIds: effect.tabIds });
          failure =
            error instanceof CommandError
              ? error
              : commandError("internal", `marker group failed: ${(error as Error).message}`);
        }
        break;
      }
      case "ungroup": {
        try {
          if (effect.tabIds.length > 0) await ungroupCommand({ tabIds: effect.tabIds });
          const { state, effects: followUp } = reduceMarker(marker, { type: "ungrouped" });
          marker = state;
          await saveMarkerState(marker);
          const followUpFailure = await runMarkerEffects(followUp);
          if (followUpFailure !== null) failure = followUpFailure;
        } catch (error) {
          logger.warn("marker ungroup failed", { error: (error as Error).message });
          failure =
            error instanceof CommandError
              ? error
              : commandError("internal", `marker ungroup failed: ${(error as Error).message}`);
        }
        break;
      }
      case "arm_grace": {
        // Idempotent: an existing alarm keeps its original deadline.
        const existing = await chrome.alarms.get(MARKER_GRACE_ALARM);
        if (existing === undefined) {
          await chrome.alarms.create(MARKER_GRACE_ALARM, { delayInMinutes: MARKER_GRACE_MINUTES });
        }
        break;
      }
      case "clear_grace": {
        await chrome.alarms.clear(MARKER_GRACE_ALARM);
        break;
      }
      case "note":
        logger.info(effect.message, effect.fields ?? {});
        break;
      default: {
        const exhaustive: never = effect;
        void exhaustive;
      }
    }
  }
  return failure;
}

function consoleSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.info(line);
}

let logger: Logger = createLogger({ scope: "ava.sw", sink: consoleSink, level: "info" });

function makeLogger(secret: string | null | undefined): Logger {
  return createLogger({
    scope: "ava.sw",
    sink: consoleSink,
    level: "info",
    secrets: secret && secret.length > 0 ? [secret] : [],
  });
}

/* ------------------------------------------------------------------ */
/* Effects                                                            */
/* ------------------------------------------------------------------ */

function send(payload: unknown): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    logger.debug("send skipped: socket not open");
    return;
  }
  socket.send(JSON.stringify(payload));
}

function closeSocket(reason: string): void {
  socketGeneration += 1;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const current = socket;
  socket = null;
  if (current === null) return;
  try {
    if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) current.close(1000, reason);
  } catch {
    // Closing an already-closing socket is not an error worth surfacing.
  }
}

function openSocket(): void {
  if (settings === null) {
    logger.warn("connect skipped: settings not loaded");
    return;
  }
  if (settings.urlError !== undefined) {
    logger.warn("connect skipped: bridge address invalid", { urlError: settings.urlError });
    return;
  }
  if (!settings.hasToken) {
    logger.warn("connect skipped: no token configured");
    return;
  }
  if (socket !== null && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    logger.debug("connect skipped: socket already active");
    return;
  }

  const generation = socketGeneration + 1;
  socketGeneration = generation;
  let ws: WebSocket;
  try {
    ws = new WebSocket(settings.bridgeUrl);
  } catch (error) {
    lastError = `cannot open socket: ${(error as Error).message}`;
    void dispatch({ type: "connect_failed", now: Date.now() });
    return;
  }
  socket = ws;

  ws.addEventListener("open", () => {
    if (generation !== socketGeneration) return;
    logger.info("socket open", { bridgeUrl: settings?.bridgeUrl });
    void dispatch({ type: "socket_open", now: Date.now() });
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    if (generation !== socketGeneration) return;
    void onSocketMessage(event.data, generation);
  });

  ws.addEventListener("close", (event: CloseEvent) => {
    if (generation !== socketGeneration) return;
    socket = null;
    if (event.code !== 1000) {
      lastError = `socket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`;
    }
    logger.info("socket closed", { code: event.code, reason: event.reason.slice(0, 120) });
    void dispatch({ type: "socket_closed", now: Date.now() });
    // The marker ungroups after a grace period rather than instantly: an MV3
    // worker that restarts must not make a live session look abandoned.
    void dispatchMarker({ type: "bridge_gone" });
  });

  ws.addEventListener("error", () => {
    // The close event always follows; log without the event object (it is not
    // usefully inspectable and may carry the URL).
    logger.warn("socket error", { bridgeUrl: settings?.bridgeUrl });
  });
}

async function runEffects(effects: SupervisorEffect[]): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case "connect":
        openSocket();
        break;
      case "send_hello":
        sendHello();
        break;
      case "send_ping":
        pingSeq += 1;
        send({ type: "ping", seq: pingSeq });
        break;
      case "close_socket":
        closeSocket(effect.reason);
        break;
      case "schedule_retry": {
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void dispatch({ type: "tick", now: Date.now() });
        }, effect.delayMs);
        break;
      }
      case "note":
        logger[effect.level](effect.message, effect.fields);
        break;
      default: {
        const exhaustive: never = effect;
        void exhaustive;
      }
    }
  }
}

async function dispatch(event: SupervisorEvent): Promise<void> {
  const { state, effects } = reduce(supervisor, event);
  supervisor = state;
  await runEffects(effects);
}

/**
 * Handshake state for the current socket (ADR 0005). `verified` turns true only
 * once the bridge has proved it holds our token; until then nothing token-derived
 * is sent and no request from the peer is acted on.
 */
let handshake: {
  generation: number;
  clientNonce: string;
  serverNonce: string | null;
  verified: boolean;
  /** Set synchronously on a verified hello_ok, before any await, so a request right behind it is served. */
  done: boolean;
} | null = null;

const UNVERIFIED_BRIDGE_HINT =
  "The bridge could not prove it holds the token pasted here. Paste the token again (gb-ava-bridge token), " +
  "or make sure the real bridge is running — something else may be answering on its port.";

function sendHello(): void {
  if (settings === null) return;
  const clientNonce = newNonce();
  handshake = { generation: socketGeneration, clientNonce, serverNonce: null, verified: false, done: false };
  const hello: ClientHello = {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    clientNonce,
    client: {
      name: "gb-ava-extension",
      version: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id,
      resumed: supervisor.hasHandshaked,
    },
  };
  send(hello);
}

/* ------------------------------------------------------------------ */
/* Inbound frames                                                     */
/* ------------------------------------------------------------------ */

/** The peer failed to prove the token: drop it and wait for a human (fail closed). */
async function rejectUnverifiedBridge(reason: string): Promise<void> {
  lastError = `${reason}. ${UNVERIFIED_BRIDGE_HINT}`;
  handshake = null;
  logger.warn("bridge not verified; closing", { reason });
  const current = socket;
  if (current !== null) {
    try {
      current.close(WS_CLOSE.serverUnverified, "bridge not verified");
    } catch {
      // Already closing.
    }
  }
  await dispatch({ type: "handshake_unverified", now: Date.now(), reason });
}

async function onSocketMessage(data: unknown, generation: number): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    logger.warn("ignored non-JSON frame from bridge");
    return;
  }
  const current = handshake !== null && handshake.generation === generation ? handshake : null;

  if (isServerChallenge(parsed)) {
    if (current === null || current.serverNonce !== null || settings === null) {
      await rejectUnverifiedBridge("unexpected handshake challenge");
      return;
    }
    current.serverNonce = parsed.serverNonce;
    const token = settings.bridgeToken;
    const valid = await verifyProof(token, PROOF_LABELS.wsServer, [current.clientNonce, parsed.serverNonce], parsed.serverProof);
    if (generation !== socketGeneration) return;
    if (!valid) {
      await rejectUnverifiedBridge("bridge proof did not match");
      return;
    }
    current.verified = true;
    const clientProof = await makeProof(token, PROOF_LABELS.wsClient, [current.clientNonce, parsed.serverNonce]);
    if (generation !== socketGeneration) return;
    send({ type: "hello_auth", clientProof });
    return;
  }

  if (isServerHello(parsed)) {
    const hello: ServerHello = parsed;
    if (hello.type === "hello_ok") {
      if (current === null || !current.verified) {
        // A "welcome" from a peer that never proved the token is exactly what an
        // impostor on the port would send.
        await rejectUnverifiedBridge("bridge skipped its proof");
        return;
      }
      // Before any await: the bridge may send a request in the very next frame.
      current.done = true;
      lastError = null;
      await markHandshaked();
      await dispatch({ type: "handshake_ok", now: Date.now(), sessionId: hello.sessionId });
      // A reconnect within the grace window keeps the marker where it is.
      await dispatchMarker({ type: "bridge_back" });
      return;
    }
    const rejection = hello.error;
    if (current === null || !current.verified) {
      // An unproven peer's refusal is not evidence of anything: it is reported as
      // "not verified", with the claimed reason quoted for the human.
      await rejectUnverifiedBridge(`bridge refused before proving itself (${rejection.code}: ${rejection.message.slice(0, 120)})`);
      return;
    }
    lastError = `${rejection.code}: ${rejection.message}`;
    const code =
      rejection.code === "unauthorized"
        ? "unauthorized"
        : rejection.code === "protocol_mismatch"
          ? "protocol_mismatch"
          : "invalid";
    await dispatch({ type: "handshake_rejected", now: Date.now(), code });
    return;
  }

  if (isControlFrame(parsed)) return;

  // Nothing from the peer is acted on before the handshake completed: a request
  // from an unproven bridge is how an impostor on the port would drive the browser.
  if (current === null || !current.verified || !current.done) {
    logger.warn("ignored request before the handshake completed");
    return;
  }

  const request = parseRequestEnvelope(parsed);
  if (!request.ok) {
    const id = isPlainObject(parsed) && typeof parsed["id"] === "string" ? (parsed["id"] as string) : "";
    if (id.length > 0) send(errorResponse(id, request.error));
    return;
  }
  await handleBridgeRequest(request.value.id, request.value.method, request.value.params);
}

async function handleBridgeRequest(id: string, method: string, params: JsonObject | undefined): Promise<void> {
  // The audit starts before validation: a refused command is still something that
  // happened, and "unknown_method x7" is exactly what a reviewer needs to see.
  const startedAt = Date.now();
  const tabId = typeof params?.["tabId"] === "number" ? (params["tabId"] as number) : null;
  const args = summariseArgs(method, params);
  const record = (code: string | null): void => {
    audit.record({
      at: new Date(startedAt).toISOString(),
      method,
      tabId,
      args,
      outcome: outcomeFor(code),
      code,
      durationMs: Date.now() - startedAt,
    });
  };

  if (!isKnownMethod(method)) {
    // Fail closed either way: a reserved-but-unbuilt method says which milestone
    // owns it, anything else is genuinely unknown. Neither is ever a no-op.
    const error = isV1Method(method)
      ? makeError("not_implemented", `${method} is reserved in protocol v1 but not built yet`)
      : makeError("unknown_method", `unknown method: ${method}`);
    record(error.code);
    send(errorResponse(id, error));
    return;
  }
  try {
    const result = await runMethod(method, params);
    record(null);
    send(okResponse(id, result));
  } catch (error) {
    const payload: ErrorPayload =
      error instanceof CommandError
        ? error.payload
        : makeError("internal", `extension failed: ${(error as Error).message}`, false);
    lastError = payload.message;
    record(payload.code);
    logger.error("command failed", { method, code: payload.code, message: payload.message });
    send(errorResponse(id, payload));
  }
}

/** The marker as Chrome currently reports it; never a remembered shape. */
async function markerView(): Promise<JsonObject> {
  const group = await readMarkerGroup(marker.groupId);
  const live = group as { color?: unknown; title?: unknown } | null;
  return {
    sessionId: marker.sessionId,
    tabIds: marker.tabIds as unknown as JsonValue,
    ungroupArmed: marker.ungroupArmed,
    graceAlarmScheduled: Boolean(await chrome.alarms.get(MARKER_GRACE_ALARM)),
    lastGraceAt,
    // What Chrome says. The constants are the promise, not the observation: a
    // human may recolour or rename the group, and health must not claim otherwise.
    // With no group there is nothing to report: a null `group` next to
    // `color: "red", title: "Ava"` says a marker exists that does not
    // (docs/protocol.md, "The marker": a dissolved group is never reported as present).
    color: typeof live?.color === "string" ? live.color : null,
    title: typeof live?.title === "string" ? live.title : null,
    group,
    tabs: (await describeTabsById(marker.tabIds)) as unknown as JsonValue,
  } as unknown as JsonObject;
}

function parsed<T>(validation: { ok: true; value: T } | { ok: false; error: ErrorPayload }): T {
  if (!validation.ok) throw new CommandError(validation.error);
  return validation.value;
}

/**
 * One method, one place. Every parameter object is validated by the shared
 * schema before a chrome.* call is made, and every failure is a protocol error.
 */
/**
 * Pages Ava never reads or drives (ADR 0005): the browser's own pages, any
 * extension page — including this extension's options, where a click could flip
 * the human-only `page.evaluate` switch — and local files.
 */
const PROTECTED_TAB_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "chrome-search:",
  "devtools:",
  "edge:",
  "view-source:",
  "file:",
];

export function isProtectedTabUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return PROTECTED_TAB_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

async function assertDrivableTab(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    // Let the method report its own not_found, with its own detail.
    return;
  }
  const url = tab.pendingUrl ?? tab.url ?? "";
  if (isProtectedTabUrl(url) || (tab.url !== undefined && isProtectedTabUrl(tab.url))) {
    throw commandError(
      "invalid_request",
      "this tab is a browser, extension or local-file page; Ava does not read or act on those",
      false,
      { tabId },
    );
  }
}

async function runMethod(method: string, params: JsonObject | undefined): Promise<JsonValue> {
  if (method.startsWith("page.") && typeof params?.["tabId"] === "number") {
    await assertDrivableTab(params["tabId"] as number);
  }
  switch (method) {
    case "health":
      return (await buildHealth()) as JsonValue;

    case "settings.get":
      // Read-only view of the owner's settings. `page.evaluate` is human-owned:
      // the agent may see the switch, never flip it (plan §5.1).
      return {
        evaluateEnabled: settings?.evaluateEnabled === true,
        evaluateEnabledBy: "human",
      };

    case "tabs.list":
      return (await listTabsCommand(parsed(parseListParams(params)))) as JsonValue;

    case "tabs.query":
      return (await queryTabsCommand(parsed(parseQueryParams(params)))) as JsonValue;

    case "tabs.navigate": {
      const navigate = parsed(parseNavigateParams(params));
      await ensureMarkerGroupLive();
      const result = await withTabLock(navigate.tabId, () => navigateCommand(navigate));
      // A tab the agent drives joins the marker, so the human can see what is
      // being touched. Outside a session nothing is painted.
      await dispatchMarker({ type: "tabs_touched", tabIds: [navigate.tabId] });
      return { ...result, marker: await markerView() } as unknown as JsonValue;
    }

    case "tabs.group": {
      const group = parsed(parseGroupParams(params));
      await requireTabs(group.tabIds);
      await ensureMarkerGroupLive();
      // One code path for grouping: the marker reducer decides the group id, so
      // an explicit tabs.group can never create a second `Ava` group.
      //
      // Unlike a navigate, the marker is what this command was asked for: Chrome
      // refusing to group (a DevTools window, a tab that closed mid-command) must
      // not come back as `ok` for a tab the human cannot see marked.
      const before = marker;
      const failure = await withTabLocks(group.tabIds, () =>
        dispatchMarker({ type: "tabs_grouped", tabIds: group.tabIds }),
      );
      if (failure !== null) {
        // The reducer claimed the tabs before the paint; a refused paint means
        // they never joined, and the marker must not keep saying they did.
        await dispatchMarker({ type: "tabs_grouped_undone", tabIds: group.tabIds, previous: before });
        throw failure;
      }
      return { marker: await markerView() } as unknown as JsonValue;
    }

    case "tabs.ungroup": {
      const ungroup = parsed(parseUngroupParams(params));
      const result = await withTabLocks(ungroup.tabIds, () => ungroupCommand(ungroup));
      await dispatchMarker({ type: "tabs_ungrouped", tabIds: ungroup.tabIds });
      // Removing the last tab from its group leaves Chrome without that group;
      // the remembered id is dead from here on.
      await ensureMarkerGroupLive();
      return { ...result, marker: await markerView() } as unknown as JsonValue;
    }

    case "tabs.close": {
      const close = parsed(parseCloseParams(params));
      await detach(close.tabId);
      forgetCapture(close.tabId);
      const result = await withTabLock(close.tabId, () => closeCommand(close));
      await dispatchMarker({ type: "tab_closed", tabId: close.tabId });
      return { ...result, marker: await markerView() } as unknown as JsonValue;
    }

    case "tabs.activate": {
      const activate = parsed(parseActivateParams(params));
      return await activateCommand(activate);
    }

    case "tabs.create": {
      const create = parsed(parseCreateParams(params));
      // A tab the agent opens joins the marker only inside a session, exactly like
      // one it navigates, so the human can see what is being driven.
      const result = await createCommand(create);
      const createdTabId = (result as { tabId?: unknown }).tabId;
      if (typeof createdTabId === "number") {
        await dispatchMarker({ type: "tabs_touched", tabIds: [createdTabId] });
      }
      return { ...result, marker: await markerView() } as unknown as JsonValue;
    }

    case "session.status": {
      parsed(parseSessionStatusParams(params));
      // The marker is reported as Chrome has it, read live: a status call is
      // where a caller learns the marker is gone, so it must not answer from a
      // group id Chrome deleted a minute ago.
      await ensureMarkerGroupLive();
      // What the marker holds, and — the part callers needed — which of those tabs
      // no longer exists, so a caller mid-sequence learns a tab vanished without
      // hitting `not_found` first.
      const open = await chrome.tabs.query({});
      const present = marker.tabIds.filter((id) => open.some((tab) => tab.id === id));
      const missing = marker.tabIds.filter((id) => !open.some((tab) => tab.id === id));
      return {
        sessionId: marker.sessionId,
        active: marker.tabIds.length > 0,
        drivenTabIds: marker.tabIds as unknown as JsonValue,
        presentTabIds: present as unknown as JsonValue,
        missingTabIds: missing as unknown as JsonValue,
        attachedTabIds: attachedTabs().map((session) => session.tabId) as unknown as JsonValue,
        marker: await markerView(),
      } as unknown as JsonValue;
    }

    case "page.readAX": {
      const read = parsed(parseReadAxParams(params));
      // A read during a navigate would otherwise pair the old URL with the new
      // document; `tab_busy` is the honest answer, and it is retryable.
      return await withTabLock(read.tabId, () => readAxCommand(read));
    }

    case "page.getText": {
      const read = parsed(parseGetTextParams(params));
      return await withTabLock(read.tabId, () => getTextCommand(read));
    }

    case "page.screenshot": {
      const shot = parsed(parseScreenshotParams(params));
      return await withTabLock(shot.tabId, () => screenshotCommand(shot));
    }

    case "page.click": {
      const click = parsed(parseClickParams(params));
      return await withTabLock(click.tabId, () => clickCommand(click));
    }

    case "page.type": {
      const type = parsed(parseTypeParams(params));
      return await withTabLock(type.tabId, () => typeCommand(type));
    }

    case "page.key": {
      const key = parsed(parseKeyParams(params));
      return await withTabLock(key.tabId, () => keyCommand(key));
    }

    case "page.scroll": {
      const scroll = parsed(parseScrollParams(params));
      return await withTabLock(scroll.tabId, () => scrollCommand(scroll));
    }

    case "page.select": {
      const select = parsed(parseSelectParams(params));
      return await withTabLock(select.tabId, () => selectCommand(select));
    }

    case "page.upload": {
      const upload = parsed(parseUploadParams(params));
      return await withTabLock(upload.tabId, () => uploadCommand(upload));
    }

    case "page.download": {
      const download = parsed(parseDownloadParams(params));
      return await withTabLock(download.tabId, () => downloadCommand(download));
    }

    case "page.waitFor": {
      const wait = parsed(parseWaitForParams(params));
      return await withTabLock(wait.tabId, () => waitForCommand(wait));
    }

    case "page.evaluate": {
      const evaluate = parsed(parseEvaluateParams(params));
      return await withTabLock(evaluate.tabId, () => evaluateCommand(evaluate, settings?.evaluateEnabled === true));
    }

    case "session.start": {
      const start = parsed(parseSessionStartParams(params));
      // The caller may name tabs; a name that is not a live tab is `not_found`
      // here, before the session exists, rather than being accepted and forgotten.
      if (start.tabIds !== undefined) await requireTabs(start.tabIds);
      const sessionId = marker.sessionId ?? crypto.randomUUID();
      await dispatchMarker({ type: "session_start", sessionId, tabIds: start.tabIds ?? [] });
      return { sessionId, marker: await markerView() } as unknown as JsonValue;
    }

    case "session.end": {
      parsed(parseSessionEndParams(params));
      const sessionId = marker.sessionId;
      const ungroupedTabIds = marker.tabIds;
      // `ungroupedTabIds` claims those tabs left the marker. If Chrome refused the
      // ungroup they are still in the `Ava` group, so the caller is told rather
      // than handed a success it cannot rely on.
      const failure = await dispatchMarker({ type: "session_end" });
      if (failure !== null) throw failure;
      return { sessionId, ungroupedTabIds, marker: await markerView() } as unknown as JsonValue;
    }

    default:
      throw commandError("unknown_method", `unhandled method: ${method}`);
  }
}

/* ------------------------------------------------------------------ */
/* Health                                                             */
/* ------------------------------------------------------------------ */

async function offscreenPresent(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function buildHealth(): Promise<JsonObject> {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  const offscreen = await offscreenPresent();
  const now = Date.now();
  return {
    worker: {
      startedAt: new Date(WORKER_STARTED_AT).toISOString(),
      uptimeMs: now - WORKER_STARTED_AT,
      startsThisInstall: workerStarts,
      phase: supervisor.phase,
      hasHandshaked: supervisor.hasHandshaked,
    },
    keepalive: {
      offscreenDocument: offscreen,
      alarmScheduled: Boolean(alarm),
      alarmPeriodMinutes: alarm?.periodInMinutes ?? null,
      ticksReceived,
      alarmTicks,
      lastTickAt: lastTickAt === null ? null : new Date(lastTickAt).toISOString(),
      reconnect: {
        attempts: supervisor.attempts,
        nextAttemptAt: supervisor.nextAttemptAt === undefined ? null : new Date(supervisor.nextAttemptAt).toISOString(),
        blockedReason: supervisor.blockedReason ?? null,
      },
    },
    session: {
      id: supervisor.sessionId ?? null,
      connectedAt: supervisor.connectedAt === undefined ? null : new Date(supervisor.connectedAt).toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      bridgeUrl: settings?.bridgeUrl ?? null,
    },
    extension: {
      name: PRODUCT_NAME,
      version: chrome.runtime.getManifest().version,
      id: chrome.runtime.id ?? null,
    },
    browser: { userAgent: navigator.userAgent },
    settings: {
      evaluateEnabled: settings?.evaluateEnabled === true,
      evaluateEnabledBy: "human",
    },
    marker: await markerView(),
    audit: audit.snapshot(20) as unknown as JsonValue,
    dialogs: {
      open: openDialogs() as unknown as JsonValue,
      recentlySeen: recentDialogs() as unknown as JsonValue,
      fileChooser: openChoosers() as unknown as JsonValue,
    },
    debugger: {
      attached: attachedTabs().map((session) => ({
        tabId: session.tabId,
        attachedForMs: Date.now() - session.attachedAt,
        version: session.version,
      })),
    },
    lastError,
  };
}

async function buildStatus(): Promise<JsonObject> {
  const token = settings?.bridgeToken ?? "";
  return {
    supervisor: {
      phase: supervisor.phase,
      attempts: supervisor.attempts,
      blockedReason: supervisor.blockedReason ?? null,
      sessionId: supervisor.sessionId ?? null,
    },
    settings: {
      bridgeUrl: settings?.bridgeUrl ?? DEFAULT_BRIDGE_URL,
      hasToken: settings?.hasToken ?? false,
      tokenFingerprint: token.length > 0 ? fingerprint(token) : null,
      urlError: settings?.urlError ?? null,
      evaluateEnabled: settings?.evaluateEnabled === true,
    },
    health: await buildHealth(),
  };
}

/* ------------------------------------------------------------------ */
/* Keepalive plumbing                                                 */
/* ------------------------------------------------------------------ */

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing !== undefined) return;
  await chrome.alarms.create(ALARM_NAME, { delayInMinutes: ALARM_PERIOD_MINUTES, periodInMinutes: ALARM_PERIOD_MINUTES });
  logger.info("alarm created", { name: ALARM_NAME, periodInMinutes: ALARM_PERIOD_MINUTES });
}

async function ensureOffscreen(): Promise<boolean> {
  if (await offscreenPresent()) return true;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        "Holds a timer that wakes the Ava bridge service worker every 20s so the loopback socket is not suspended between commands.",
    });
    logger.info("offscreen document created");
    return true;
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (message.includes("Only a single offscreen")) return true;
    lastError = `offscreen document failed: ${message}`;
    logger.warn("offscreen document failed", { error: message });
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

/** Set once bootstrap has finished loading state; startup handlers await it. */
let bootstrapReady: Promise<void> | null = null;

async function bootstrap(): Promise<void> {
  workerStarts = await bumpWorkerStarts();
  marker = await loadMarkerState();
  // Tab and group ids are unique only within one browser session. After a worker
  // restart they are still valid; after a browser restart they are not, which is
  // what `chrome.runtime.onStartup` handles below. Here we only drop a group that
  // no longer exists, so health cannot claim a marker Chrome has forgotten.
  if (marker.groupId !== null && (await readMarkerGroup(marker.groupId)) === null) {
    marker = { ...marker, grouped: false, groupId: null };
    await saveMarkerState(marker);
  }
  settings = await readSettings();
  logger = makeLogger(settings.bridgeToken);
  lastError = settings.urlError ?? null;
  await ensureAlarm();
  const offscreen = await ensureOffscreen();
  const hasHandshaked = await readHasHandshaked();
  logger.info("worker started", {
    startsThisInstall: workerStarts,
    hasToken: settings.hasToken,
    bridgeUrl: settings.bridgeUrl,
    offscreen,
    tokenFingerprint: settings.hasToken ? fingerprint(settings.bridgeToken) : null,
  });
  await dispatch({
    type: "boot",
    now: Date.now(),
    hasToken: settings.hasToken && settings.urlError === undefined,
    hasHandshaked,
  });
  // A worker that died with the socket open never ran the close handler, so the
  // grace alarm was never armed. Arm it now: the session outliving a permanent
  // bridge loss is the failure this exists to prevent.
  if (marker.tabIds.length > 0 && socket === null && !marker.ungroupArmed) {
    await dispatchMarker({ type: "bridge_gone" });
  }
  // Armed with no alarm is a terminal state: the one-shot alarm was consumed but
  // the worker died before the state was updated. Settle it now rather than
  // leaving a marker nobody will ever ungroup.
  if (marker.ungroupArmed) {
    const alarm = await chrome.alarms.get(MARKER_GRACE_ALARM);
    if (alarm === undefined) {
      const connected = socket !== null && socket.readyState === WebSocket.OPEN;
      await dispatchMarker({ type: "grace_expired", stillDisconnected: !connected });
    }
  }
}


chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MARKER_GRACE_ALARM) {
    const connected = socket !== null && socket.readyState === WebSocket.OPEN;
    lastGraceAt = { at: new Date().toISOString(), connected, armed: marker.ungroupArmed, tabs: marker.tabIds.length };
    void dispatchMarker({ type: "grace_expired", stillDisconnected: !connected });
    return;
  }
  if (alarm.name !== ALARM_NAME) return;
  lastTickAt = Date.now();
  alarmTicks += 1;
  void dispatch({ type: "tick", now: Date.now() });
});

// A tab the human closes leaves the marker, whether or not a command is running.
chrome.tabs.onRemoved.addListener((tabId) => {
  clearDialogs(tabId);
  void detach(tabId);
  forgetCapture(tabId);
  if (!marker.tabIds.includes(tabId)) return;
  void dispatchMarker({ type: "tab_closed", tabId });
});

// A navigation invalidates both the capture baseline and the debugger session's
// document: the old frame and the old node ids mean nothing on the new page.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading") return;
  // A new document: the old frame, the old node ids and the debugger's view of
  // the previous page are all worthless now.
  forgetCapture(tabId);
  bumpDocumentEpoch(tabId);
  // A navigation dismisses any dialog the old document had.
  clearDialogs(tabId);
  void detach(tabId);
});

chrome.runtime.onSuspend.addListener(() => {
  // Best effort: the infobar should not outlive an idle worker.
  void detachAll();
});

/**
 * Which of this extension's own pages may send which message. Settings changes
 * come only from the options page, the keepalive only from the offscreen
 * document; anything else (another context, a future content script) is ignored.
 */
function senderPage(sender: chrome.runtime.MessageSender): "options" | "offscreen" | null {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") return null;
  const path = sender.url.split(/[?#]/)[0];
  if (path === chrome.runtime.getURL("options.html")) return "options";
  if (path === chrome.runtime.getURL("offscreen.html")) return "offscreen";
  return null;
}

const MESSAGE_SENDERS: Record<string, "options" | "offscreen"> = {
  "ava.keepalive.tick": "offscreen",
  "ava.status": "options",
  "ava.reconnect": "options",
  "ava.save": "options",
  "ava.setEvaluate": "options",
  "ava.clear": "options",
};

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isPlainObject(message) || typeof message["type"] !== "string") return false;
  const expected = MESSAGE_SENDERS[message["type"]];
  if (expected === undefined || senderPage(sender) !== expected) {
    logger.warn("ignored message from an unexpected sender", { type: String(message["type"]).slice(0, 40) });
    return false;
  }
  switch (message["type"]) {
    case "ava.keepalive.tick":
      ticksReceived += 1;
      lastTickAt = Date.now();
      void dispatch({ type: "tick", now: Date.now() });
      sendResponse({ ok: true });
      return false;
    case "ava.status":
      void buildStatus().then(sendResponse);
      return true;
    case "ava.reconnect":
      void (async () => {
        settings = await readSettings();
        await dispatch({
          type: "reconnect_requested",
          now: Date.now(),
          hasToken: settings.hasToken && settings.urlError === undefined,
        });
        sendResponse(await buildStatus());
      })();
      return true;
    case "ava.save":
      void (async () => {
        const url = typeof message["bridgeUrl"] === "string" ? message["bridgeUrl"] : DEFAULT_BRIDGE_URL;
        const token = typeof message["bridgeToken"] === "string" ? message["bridgeToken"] : "";
        selfSaveInFlight = true;
        const saved = await saveSettings(url, token);
        if (!saved.ok) {
          // No storage change will fire for a refused save, so the flag must not
          // outlive this branch: otherwise the next settings change from another
          // context is mistaken for this one and never reconnects.
          selfSaveInFlight = false;
          sendResponse({ ok: false, error: saved.error, status: await buildStatus() });
          return;
        }
        settings = await readSettings();
        logger = makeLogger(settings.bridgeToken);
        await dispatch({
          type: "reconnect_requested",
          now: Date.now(),
          hasToken: settings.hasToken && settings.urlError === undefined,
        });
        sendResponse({ ok: true, status: await buildStatus() });
      })();
      return true;
    case "ava.setEvaluate":
      void (async () => {
        await setEvaluateEnabled(message["enabled"] === true);
        settings = await readSettings();
        sendResponse({ ok: true, status: await buildStatus() });
      })();
      return true;
    case "ava.clear":
      void (async () => {
        await clearToken();
        settings = await readSettings();
        await dispatch({ type: "settings_changed", now: Date.now(), hasToken: false });
        sendResponse({ ok: true, status: await buildStatus() });
      })();
      return true;
    default:
      return false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const connectionChanged = ["bridgeUrl", "bridgeToken"].some((key) => key in changes);
  if (!connectionChanged) {
    // The page.evaluate switch takes effect on the next command; it needs no
    // reconnect and no worker restart (plan §5.1).
    if ("evaluateEnabled" in changes) {
      void (async () => {
        settings = await readSettings();
        logger.info("page.evaluate switch changed", { evaluateEnabled: settings.evaluateEnabled });
      })();
    }
    return;
  }
  void (async () => {
    const next = await readSettings();
    logger = makeLogger(next.bridgeToken);
    if (selfSaveInFlight) {
      selfSaveInFlight = false;
      settings = next;
      return;
    }
    const unchanged =
      settings !== null &&
      next.bridgeUrl === settings.bridgeUrl &&
      next.bridgeToken === settings.bridgeToken &&
      next.hasToken === settings.hasToken;
    settings = next;
    if (unchanged) return;
    logger.info("settings changed", { hasToken: settings.hasToken });
    await dispatch({
      type: "settings_changed",
      now: Date.now(),
      hasToken: settings.hasToken && settings.urlError === undefined,
    });
  })();
});

chrome.runtime.onInstalled.addListener((details) => {
  logger.info("installed", { reason: details.reason });
  void ensureAlarm();
  void ensureOffscreen();
});

/**
 * A browser restart ends every session: tab and group ids from the previous run
 * mean nothing, and ungrouping against them could pull unrelated tabs out of the
 * human's own groups. The reset waits for bootstrap, otherwise it would read the
 * pre-load marker state and skip itself.
 */
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void ensureOffscreen();
  void (async () => {
    if (bootstrapReady !== null) await bootstrapReady.catch(() => undefined);
    if (marker.tabIds.length === 0 && marker.groupId === null) return;
    logger.info("browser started; resetting the marker");
    await dispatchMarker({ type: "reset", reason: "browser_start" });
  })();
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onSuspend.addListener(() => {
  logger.info("worker suspending", { phase: supervisor.phase });
});

bootstrapReady = bootstrap();
void bootstrapReady.catch((error: unknown) => {
  logger.error("bootstrap failed", { error: (error as Error).message });
});

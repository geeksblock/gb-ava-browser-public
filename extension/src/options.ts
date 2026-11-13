/**
 * Options page — the only place a human types the bridge token.
 *
 * It talks to the service worker by message; it holds no state of its own and
 * never reads the token back into the UI (a saved token is shown as a
 * fingerprint, not echoed into the password field).
 */

import type { JsonObject } from "@gb-ava/protocol";

interface StatusReply {
  settings?: {
    bridgeUrl?: string;
    hasToken?: boolean;
    tokenFingerprint?: string | null;
    urlError?: string | null;
    evaluateEnabled?: boolean;
  };
  supervisor?: { phase?: string; attempts?: number; blockedReason?: string | null; sessionId?: string | null };
  health?: JsonObject;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`options page is missing #${id}`);
  return element as T;
}

const form = byId<HTMLFormElement>("settings-form");
const urlInput = byId<HTMLInputElement>("bridge-url");
const tokenInput = byId<HTMLInputElement>("bridge-token");
const notice = byId<HTMLParagraphElement>("notice");
const phaseBadge = byId<HTMLSpanElement>("phase-badge");
const fingerprintEl = byId<HTMLSpanElement>("token-fingerprint");
const reconnectButton = byId<HTMLButtonElement>("reconnect");
const evaluateToggle = byId<HTMLInputElement>("evaluate-enabled");
const evaluateNote = byId<HTMLParagraphElement>("evaluate-note");
const clearButton = byId<HTMLButtonElement>("clear");

function setNotice(message: string, tone: "info" | "error"): void {
  notice.hidden = message.length === 0;
  notice.textContent = message;
  notice.dataset["tone"] = tone;
}

function text(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = value;
}

function formatUptime(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function render(status: StatusReply): void {
  const phase = status.supervisor?.phase ?? "unknown";
  phaseBadge.textContent = phase;
  phaseBadge.dataset["phase"] = phase;

  const settings = status.settings ?? {};
  if (document.activeElement !== urlInput) {
    urlInput.value = settings.bridgeUrl ?? "";
  }
  fingerprintEl.textContent = settings.tokenFingerprint ?? "none";
  if (settings.hasToken === true) {
    tokenInput.placeholder = "saved — paste a new token to replace it";
  } else {
    tokenInput.placeholder = "paste the token from gb-ava-bridge token";
  }

  const evaluateEnabled = settings.evaluateEnabled === true;
  if (document.activeElement !== evaluateToggle) evaluateToggle.checked = evaluateEnabled;
  evaluateNote.textContent = evaluateEnabled
    ? "Currently on — page.evaluate runs only when Ava asks for it, and its result is truncated in the log."
    : "Currently off — page.evaluate returns evaluate_disabled.";

  const health = (status.health ?? {}) as Record<string, unknown>;
  const worker = (health["worker"] ?? {}) as Record<string, unknown>;
  const keepalive = (health["keepalive"] ?? {}) as Record<string, unknown>;
  const reconnect = (keepalive["reconnect"] ?? {}) as Record<string, unknown>;

  text("status-phase", phase);
  text("status-session", status.supervisor?.sessionId ?? "—");
  text("status-uptime", formatUptime(typeof worker["uptimeMs"] === "number" ? (worker["uptimeMs"] as number) : undefined));
  text(
    "status-starts",
    typeof worker["startsThisInstall"] === "number" ? String(worker["startsThisInstall"]) : "—",
  );
  text("status-offscreen", keepalive["offscreenDocument"] === true ? "present" : "missing");
  text(
    "status-alarm",
    keepalive["alarmScheduled"] === true ? `scheduled every ${String(keepalive["alarmPeriodMinutes"] ?? "?")} min` : "not scheduled",
  );
  text(
    "status-ticks",
    typeof keepalive["ticksReceived"] === "number" ? String(keepalive["ticksReceived"]) : "—",
  );
  text(
    "status-attempts",
    typeof reconnect["attempts"] === "number"
      ? String(reconnect["attempts"]) + (reconnect["blockedReason"] ? ` (blocked: ${String(reconnect["blockedReason"])})` : "")
      : "—",
  );
  const lastError = health["lastError"];
  text("status-error", typeof lastError === "string" && lastError.length > 0 ? lastError : "none");
}

async function requestStatus(): Promise<StatusReply | null> {
  try {
    const reply: unknown = await chrome.runtime.sendMessage({ type: "ava.status" });
    if (typeof reply !== "object" || reply === null) return null;
    return reply as StatusReply;
  } catch {
    // The worker may be restarting; the next poll will pick it up.
    return null;
  }
}

async function refresh(): Promise<void> {
  const status = await requestStatus();
  if (status !== null) render(status);
}

/**
 * A save can only be answered with "connecting": the socket has not opened yet.
 * Follow up for a few seconds so the badge shows what is actually true instead of
 * leaving a human on "connecting" until the next five-second poll.
 */
function followUpRefresh(): void {
  for (const delay of [400, 1_200, 2_500, 4_000]) {
    setTimeout(() => void refresh(), delay);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const reply: unknown = await chrome.runtime.sendMessage({
      type: "ava.save",
      bridgeUrl: urlInput.value,
      bridgeToken: tokenInput.value,
    });
    const result = reply as { ok?: boolean; error?: string; status?: StatusReply } | null;
    if (result?.ok === true) {
      tokenInput.value = "";
      setNotice("Saved. The worker is reconnecting now.", "info");
      if (result.status) render(result.status);
      followUpRefresh();
      return;
    }
    setNotice(result?.error ?? "Could not save the settings.", "error");
  })();
});

reconnectButton.addEventListener("click", () => {
  void (async () => {
    setNotice("Reconnecting…", "info");
    const reply: unknown = await chrome.runtime.sendMessage({ type: "ava.reconnect" });
    const result = reply as StatusReply | null;
    if (result) render(result);
    setNotice("Reconnect requested.", "info");
    followUpRefresh();
  })();
});

evaluateToggle.addEventListener("change", () => {
  void (async () => {
    const enabled = evaluateToggle.checked;
    const reply: unknown = await chrome.runtime.sendMessage({ type: "ava.setEvaluate", enabled });
    const result = reply as { ok?: boolean; status?: StatusReply } | null;
    if (result?.status) render(result.status);
    setNotice(enabled ? "page.evaluate enabled." : "page.evaluate disabled.", "info");
  })();
});

clearButton.addEventListener("click", () => {
  void (async () => {
    const reply: unknown = await chrome.runtime.sendMessage({ type: "ava.clear" });
    const result = reply as { status?: StatusReply } | null;
    if (result?.status) render(result.status);
    setNotice("Token forgotten. Paste a token to reconnect.", "info");
  })();
});

text("year", String(new Date().getFullYear()));
void refresh();
setInterval(() => void refresh(), 5_000);

/**
 * Extension settings. The token is the bridge's per-install secret: it lives in
 * chrome.storage.local only (never `sync`, so it is not uploaded anywhere), and
 * it is never rendered back to the user in full — only its fingerprint.
 */

export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8765";

export const STORAGE_KEYS = {
  bridgeUrl: "bridgeUrl",
  bridgeToken: "bridgeToken",
  hasHandshaked: "hasHandshaked",
  workerStarts: "workerStarts",
  evaluateEnabled: "evaluateEnabled",
} as const;

export interface Settings {
  bridgeUrl: string;
  bridgeToken: string;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * Loopback only, by construction. `localhost` is rejected on purpose: it may
 * resolve to ::1 while the bridge binds 127.0.0.1, which produces a confusing
 * "connection refused" instead of a clear error.
 */
export function normaliseBridgeUrl(input: string): UrlCheck {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: "bridge address is empty" };
  const withScheme = trimmed.includes("://") ? trimmed : `ws://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "bridge address is not a valid URL" };
  }
  if (parsed.protocol !== "ws:") {
    return { ok: false, error: "bridge address must use ws:// (the bridge has no TLS)" };
  }
  if (parsed.hostname !== "127.0.0.1") {
    return { ok: false, error: "bridge address must be 127.0.0.1 — the bridge never leaves this machine" };
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    return { ok: false, error: "bridge address must not carry a query string or fragment" };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "/extension") {
    return { ok: false, error: "bridge address must not carry a path" };
  }
  const port = parsed.port;
  if (port.length === 0) return { ok: false, error: "bridge address must include a port" };
  const numericPort = Number.parseInt(port, 10);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    return { ok: false, error: "bridge port must be 1-65535" };
  }
  // The bridge accepts the extension socket only on /extension (anything else is
  // refused at the upgrade), so the stored address always carries it.
  return { ok: true, url: `ws://127.0.0.1:${numericPort}/extension` };
}

export interface LoadedSettings {
  bridgeUrl: string;
  bridgeToken: string;
  hasToken: boolean;
  /**
   * Owner decision (plan §5.1): `page.evaluate` ships behind a switch that only
   * a human flips in the options page. Default off. Nothing in the protocol may
   * set it, which is why the only writer is `setEvaluateEnabled` from the
   * options page.
   */
  evaluateEnabled: boolean;
  urlError?: string;
}

export async function readSettings(): Promise<LoadedSettings> {
  const raw = await chrome.storage.local.get([
    STORAGE_KEYS.bridgeUrl,
    STORAGE_KEYS.bridgeToken,
    STORAGE_KEYS.evaluateEnabled,
  ]);
  const token = typeof raw[STORAGE_KEYS.bridgeToken] === "string" ? (raw[STORAGE_KEYS.bridgeToken] as string).trim() : "";
  const storedUrl = typeof raw[STORAGE_KEYS.bridgeUrl] === "string" ? (raw[STORAGE_KEYS.bridgeUrl] as string) : DEFAULT_BRIDGE_URL;
  const evaluateEnabled = raw[STORAGE_KEYS.evaluateEnabled] === true;
  const checked = normaliseBridgeUrl(storedUrl);
  if (!checked.ok) {
    return { bridgeUrl: storedUrl, bridgeToken: token, hasToken: token.length > 0, evaluateEnabled, urlError: checked.error };
  }
  return { bridgeUrl: checked.url, bridgeToken: token, hasToken: token.length > 0, evaluateEnabled };
}

/**
 * The one writer of the `page.evaluate` switch. Called from the options page only
 * (human-initiated); no protocol method reaches it.
 */
export async function setEvaluateEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.evaluateEnabled]: enabled === true });
}

export async function saveSettings(bridgeUrl: string, bridgeToken: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const checked = normaliseBridgeUrl(bridgeUrl);
  if (!checked.ok) return { ok: false, error: checked.error };
  const token = bridgeToken.trim();
  if (token.length === 0) return { ok: false, error: "token is empty — copy it from `gb-ava-bridge token`" };
  await chrome.storage.local.set({ [STORAGE_KEYS.bridgeUrl]: checked.url, [STORAGE_KEYS.bridgeToken]: token });
  return { ok: true };
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_KEYS.bridgeToken, STORAGE_KEYS.hasHandshaked]);
}

export async function readHasHandshaked(): Promise<boolean> {
  const raw = await chrome.storage.local.get([STORAGE_KEYS.hasHandshaked]);
  return raw[STORAGE_KEYS.hasHandshaked] === true;
}

export async function markHandshaked(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.hasHandshaked]: true });
}

/** Counts how many times the MV3 worker has started, so "did it die?" is answerable. */
export async function bumpWorkerStarts(): Promise<number> {
  const raw = await chrome.storage.local.get([STORAGE_KEYS.workerStarts]);
  const previous = typeof raw[STORAGE_KEYS.workerStarts] === "number" ? (raw[STORAGE_KEYS.workerStarts] as number) : 0;
  const next = previous + 1;
  await chrome.storage.local.set({ [STORAGE_KEYS.workerStarts]: next });
  return next;
}

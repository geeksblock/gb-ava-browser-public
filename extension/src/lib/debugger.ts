/**
 * The `chrome.debugger` session, kept as narrow as the milestone needs.
 *
 * Why the debugger at all: reading a *background* tab's accessibility tree and
 * pixels is the product thesis, and neither `chrome.scripting` (DOM only, no
 * computed accessibility, no pixels) nor `chrome.tabs.captureVisibleTab` (visible
 * area only, needs the window in front) can do it. CDP can, and attaching to one
 * tab does not bring it forward.
 *
 * Rules this file enforces:
 *   - attach only to the tab a command names, and never a second attach for the
 *     same tab while one is alive;
 *   - a DevTools window on the tab makes attach fail — reported as
 *     `debugger_unavailable`, never retried silently;
 *   - every CDP call is bounded: a hung renderer must not hold a command open
 *     past the bridge's own timeout;
 *   - detach on tab close, on navigation away, and after an idle period, so the
 *     "Ava started debugging this browser" infobar goes away by itself.
 */

import { chooserOpened, clearDialogs, dialogClosed, dialogOpened } from "./dialogs.js";
import { commandError } from "./errors.js";

export interface Attached {
  tabId: number;
  attachedAt: number;
  version: string;
}

const sessions = new Map<number, Attached>();
/** An attach that is in progress, so two concurrent reads cannot race one attach. */
const attaching = new Map<number, Promise<void>>();
let listenerInstalled = false;

/** Idle detach: a tab read once should not keep Chrome's infobar up forever. */
const IDLE_DETACH_MS = 120_000;
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();

function armIdleDetach(tabId: number): void {
  const existing = idleTimers.get(tabId);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    idleTimers.delete(tabId);
    void detach(tabId);
  }, IDLE_DETACH_MS);
  // Node's timer type in an MV3 worker; `unref` does not exist, so keep a handle.
  idleTimers.set(tabId, timer);
}

function clearIdleDetach(tabId: number): void {
  const existing = idleTimers.get(tabId);
  if (existing !== undefined) clearTimeout(existing);
  idleTimers.delete(tabId);
}

function installDetachListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (typeof source.tabId === "number") {
      sessions.delete(source.tabId);
      // No session means no dialog can still be open: a dialog cannot outlive the
      // document it belongs to, and this is the event that tells us it is gone.
      clearDialogs(source.tabId);
      void reason;
    }
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (typeof source.tabId !== "number") return;
    if (method === "Page.javascriptDialogOpening") {
      const record = params as { type?: string; message?: string };
      dialogOpened(source.tabId, { type: record.type ?? "alert", message: record.message ?? "" });
      return;
    }
    if (method === "Page.javascriptDialogClosed") dialogClosed(source.tabId);
    if (method === "Page.fileChooserOpened") {
      const record = params as { backendNodeId?: number; mode?: string };
      chooserOpened(source.tabId, typeof record.backendNodeId === "number" ? record.backendNodeId : null);
    }
  });
}

export function attachedTabs(): Attached[] {
  return [...sessions.values()];
}

export function isAttached(tabId: number): boolean {
  return sessions.has(tabId);
}

/**
 * Whether a tab still exists. Used to tell "the tab is gone" (`not_found`, never
 * retry) from "the debugger lost it" (`debugger_unavailable`, retry) — the two
 * causes of a detach that the error text alone cannot distinguish.
 *
 * Any failure to answer is treated as "still exists": an unknown state must not
 * silently downgrade a retryable debugger problem into a permanent not_found.
 */
async function tabStillExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** Attach to one tab, or fail closed with `debugger_unavailable`. */
export async function ensureAttached(tabId: number): Promise<void> {
  installDetachListener();
  if (sessions.has(tabId)) {
    armIdleDetach(tabId);
    return;
  }
  const inFlight = attaching.get(tabId);
  if (inFlight !== undefined) {
    await inFlight;
    armIdleDetach(tabId);
    return;
  }
  const attempt = attachNow(tabId).finally(() => attaching.delete(tabId));
  attaching.set(tabId, attempt);
  await attempt;
  armIdleDetach(tabId);
}

async function attachNow(tabId: number): Promise<void> {
  const target: chrome.debugger.Debuggee = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (error) {
    const message = (error as Error).message;
    // "Another debugger is already attached" is ambiguous: it is either our own
    // session surviving a worker restart, or DevTools owning the tab. Probe with
    // the cheapest command; only a working session is ours to adopt.
    if (/already attached/i.test(message)) {
      try {
        await chrome.debugger.sendCommand(target, "Browser.getVersion");
        sessions.set(tabId, { tabId, attachedAt: Date.now(), version: "1.3" });
        return;
      } catch {
        throw commandError(
          "debugger_unavailable",
          `cannot attach to tab ${tabId}: another debugger owns it`,
          true,
          { tabId, hint: "Close DevTools on that tab and retry" },
        );
      }
    }
    throw commandError(
      "debugger_unavailable",
      `cannot attach to tab ${tabId}: ${message}`,
      true,
      { tabId, hint: "Close DevTools on that tab and retry" },
    );
  }

  // Dialogs and navigations are reported through the Page domain; enable it for
  // every session so any action — not just click — can tell a dialog is up.
  try {
    await chrome.debugger.sendCommand(target, "Page.enable");
  } catch {
    // Page.enable failing only costs dialog and navigation events on this tab.
  }

  // `getVersion` is the cheapest proof the session is real; attach can resolve
  // before the target is ready.
  let version = "1.3";
  try {
    const info = (await chrome.debugger.sendCommand(target, "Browser.getVersion")) as { product?: string };
    version = typeof info.product === "string" ? info.product : version;
  } catch {
    // Not fatal: the session is attached, the product string is a nicety.
  }
  sessions.set(tabId, { tabId, attachedAt: Date.now(), version });
}

export async function detach(tabId: number): Promise<void> {
  clearIdleDetach(tabId);
  clearDialogs(tabId);
  if (!sessions.delete(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already gone (tab closed, user cancelled): nothing to undo.
  }
}

/**
 * Intercept the file chooser for the duration of one agent action.
 *
 * It is a page-level setting: leaving it on would swallow the *owner's* own
 * "Choose file" clicks in any tab Ava has touched, because Chrome routes the
 * chooser to the debugger instead of showing the native picker. So it is enabled
 * around the action that might open one, and turned off again afterwards — unless
 * a chooser is actually pending, which `page.upload` (or the release below)
 * answers.
 */
export async function withChooserInterception<T>(tabId: number, pending: () => boolean, run: () => Promise<T>): Promise<T> {
  const set = async (enabled: boolean): Promise<void> => {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled });
    } catch {
      // Not fatal: a chooser simply behaves natively.
    }
  };
  await set(true);
  try {
    return await run();
  } finally {
    // Never awaited: a click that opened a modal dialog blocks the renderer, and
    // waiting for this Page command would turn "a human is needed" into a timeout.
    // A pending chooser is answered out of band by an upload, so interception stays
    // on in that case.
    if (!pending()) void set(false);
  }
}

/** Detach from every tab we hold, for shutdown and for the tests. */
export async function detachAll(): Promise<void> {
  for (const tabId of [...sessions.keys()]) await detach(tabId);
}

/**
 * One CDP call, bounded. A renderer that never answers must not hold the command
 * open: the bridge gives up at 10 s, so this gives up before that and says
 * `timeout` rather than `extension_disconnected`.
 */
export async function send<T>(tabId: number, method: string, params?: Record<string, unknown>, timeoutMs = 5_000): Promise<T> {
  await ensureAttached(tabId);
  const target: chrome.debugger.Debuggee = { tabId };
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const call = chrome.debugger.sendCommand(target, method, params) as Promise<T>;
    const timeout = new Promise<never>((resolve, reject) => {
      void resolve;
      timer = setTimeout(() => {
        reject(commandError("timeout", `tab ${tabId} did not answer ${method} within ${timeoutMs} ms`, false, { tabId, method }));
      }, timeoutMs);
    });
    return await Promise.race([call, timeout]);
  } catch (error) {
    if (error instanceof Error && "payload" in error) throw error;
    const message = (error as Error).message;
    // A vanished tab is `not_found`, not a debugger problem: the caller named a
    // tab that no longer exists.
    if (/no tab with id/i.test(message)) {
      sessions.delete(tabId);
      throw commandError("not_found", `tab ${tabId} no longer exists`, false, { tabId });
    }
    // A session that died under us. Two different causes land here — the tab was
    // closed, or DevTools attached — and they must not be reported the same way:
    // `debugger_unavailable` is retryable, so a caller told that for a tab that no
    // longer exists retries forever. Ask Chrome whether the tab is
    // still there rather than guessing from the message text.
    if (/detached|not attached|closed/i.test(message)) {
      sessions.delete(tabId);
      const stillThere = await tabStillExists(tabId);
      if (!stillThere) {
        throw commandError("not_found", `tab ${tabId} no longer exists`, false, { tabId });
      }
      throw commandError("debugger_unavailable", `debugger session for tab ${tabId} ended: ${message}`, true, { tabId, method });
    }
    throw commandError("internal", `${method} failed on tab ${tabId}: ${message}`, false, { tabId, method });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

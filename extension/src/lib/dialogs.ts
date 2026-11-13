/**
 * JavaScript-dialog state, per tab.
 *
 * A modal dialog blocks the renderer: CDP input sent while one is open never
 * answers, and a scripting call queues behind it. So the extension tracks dialogs
 * per tab and reports `needs_human` rather than letting a command rot into a
 * timeout.
 *
 * Per tab, deliberately. Module-global state (the first version) meant a dialog in
 * one tab made every action on every tab report `needs_human`, and a missed close
 * event wedged all of them until the worker restarted.
 *
 * The open set is cleared whenever the session or the document it belonged to goes
 * away: detach, tab close, navigation. A dialog cannot outlive those.
 */

export interface DialogState {
  type: string;
  message: string;
  /** When it opened; used to describe a dialog that closed inside a settle window. */
  at: number;
}

const open = new Map<number, DialogState>();
const last = new Map<number, DialogState>();

/**
 * A file chooser is not modal: the page keeps working and the input simply waits.
 * So it is reported (the caller should know a human was expected to pick a file)
 * but it never blocks a later command — `page.upload` satisfies it instead.
 */
const choosers = new Map<number, { backendNodeId: number | null; at: number; synthetic: boolean }>();

export function dialogOpened(tabId: number, dialog: Omit<DialogState, "at">): void {
  const state: DialogState = { ...dialog, at: Date.now() };
  open.set(tabId, state);
  last.set(tabId, state);
}

export function dialogClosed(tabId: number): void {
  open.delete(tabId);
}

export function openDialog(tabId: number): DialogState | null {
  return open.get(tabId) ?? null;
}

/**
 * The dialog that just opened, for a command that caused it: a dialog can open and
 * be dismissed (by the browser or another client) faster than a poll observes it,
 * and the command that caused it still has to say so.
 */
export function recentDialog(tabId: number, withinMs = 5_000): DialogState | null {
  const entry = last.get(tabId);
  if (entry === undefined) return null;
  return Date.now() - entry.at <= withinMs ? entry : null;
}

/**
 * Record a pending chooser. `synthetic` marks one the extension inferred — a click
 * dispatched inside the page carries no user activation, so Chrome never opens a
 * picker for it and no `Page.fileChooserOpened` will arrive. A synthetic record is
 * a one-shot signal: it tells the caller to answer with `page.upload`, and it is
 * cleared when the next input command starts, because nothing is actually waiting.
 */
export function chooserOpened(tabId: number, backendNodeId: number | null, synthetic = false): void {
  choosers.set(tabId, { backendNodeId, at: Date.now(), synthetic });
}

/** Forget a synthetic chooser, if that is what is pending. A real one stays. */
export function clearSyntheticChooser(tabId: number): void {
  const entry = choosers.get(tabId);
  if (entry?.synthetic === true) choosers.delete(tabId);
}

export function chooserResolved(tabId: number): void {
  choosers.delete(tabId);
}

export function openChooser(tabId: number): { backendNodeId: number | null; at: number; synthetic: boolean } | null {
  return choosers.get(tabId) ?? null;
}

/** A chooser Chrome is really holding: the one that keeps interception armed. */
export function openRealChooser(tabId: number): { backendNodeId: number | null; at: number; synthetic: boolean } | null {
  const entry = choosers.get(tabId);
  return entry !== undefined && !entry.synthetic ? entry : null;
}

export function openChoosers(): Array<{ tabId: number; backendNodeId: number | null; at: number; synthetic: boolean }> {
  return [...choosers.entries()].map(([tabId, entry]) => ({ tabId, ...entry }));
}

/** Called on detach, tab close and navigation: a dialog cannot survive those. */
export function clearDialogs(tabId: number): void {
  open.delete(tabId);
  last.delete(tabId);
  choosers.delete(tabId);
}

export function openDialogs(): Array<{ tabId: number; dialog: DialogState }> {
  return [...open.entries()].map(([tabId, dialog]) => ({ tabId, dialog }));
}

export function recentDialogs(): Array<{ tabId: number; dialog: DialogState }> {
  return [...last.entries()].map(([tabId, dialog]) => ({ tabId, dialog }));
}

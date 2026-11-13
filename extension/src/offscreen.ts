/**
 * Offscreen document — keeper #1 for the service worker.
 *
 * It does exactly one thing: wake the worker every 20s. Chrome suspends MV3
 * service workers after ~30s of inactivity; a message from this document counts
 * as activity, and receiving it lets the worker ping the bridge (which keeps the
 * socket alive as well). Nothing here may make decisions — the supervisor in the
 * worker owns the state machine.
 */

const TICK_INTERVAL_MS = 20_000;

function tick(): void {
  // The worker may be mid-termination; a rejected promise here is expected and
  // must not surface as an unhandled rejection.
  void chrome.runtime.sendMessage({ type: "ava.keepalive.tick" }).catch(() => undefined);
}

setInterval(tick, TICK_INTERVAL_MS);
tick();

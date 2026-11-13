# ADR 0003 — The service worker owns the socket; the offscreen document only keeps it awake

- **Status:** Proposed (implemented in M0; awaiting owner review)
- **Date:** 2026-10-30
- **Related:** `IMPLEMENTATION-PLAN.md` §3, §7, §10.3; `docs/protocol.md`; ADR 0002

## Context

MV3 suspends service workers after ~30 s of inactivity. Every design in this space has to answer one
question: **where does the persistent connection live?**

Options considered:

| Where the socket lives | Precedent | Consequence |
| --- | --- | --- |
| Service worker | Plan §3's diagram | `chrome.*` calls are local to the connection; the worker must be kept awake or the socket dies with it |
| Offscreen document | A common pattern in extension-as-agent products | The connection outlives worker suspension, but every command needs a hop to the worker for `chrome.tabs`/`scripting`/`debugger`, and MV3 offscreen lifetime is itself not unlimited |
| Native messaging host | `hangwin/mcp-chrome` (MIT) | Cleanest transport (no TCP port), but requires a registered host binary per browser per OS, and the extension cannot dial it — the host must speak first |

## Decision

The socket lives in the **service worker**. The offscreen document exists only to send a keepalive
tick every 20 s; a `chrome.alarms` heartbeat is the second, independent keeper. All decisions live in
a pure state machine (`extension/src/lib/supervisor.ts`) that has no access to `chrome.*`, timers or
sockets, so the behaviour is unit-testable and replayable.

## Rationale

- A command that arrives anywhere but the worker needs a message hop before it can touch a tab.
  During a hop the worker can be suspended; the hop also makes "did the command run?" ambiguous,
  which conflicts with the no-silent-retries rule.
- Keeping the socket in the worker makes the failure mode honest and simple: if the worker dies, the
  socket closes, the bridge fails every in-flight command with `extension_disconnected`, and nothing
  is replayed. There is exactly one place where "the connection" is defined.
- The worker's idle timer is reset by any activity. The offscreen tick gives it activity every 20 s
  and the ping gives the bridge a matching liveness signal, so the connection is not merely held open
  by a timer that might not fire.

## Consequences

**Positive**

- One owner of connection state; no duplicate sockets, no message hop per command.
- Failure is loud and attributable: bridge sees a close, caller gets `extension_disconnected`.
- The supervisor can be tested without a browser (see `tests/unit/supervisor.test.ts`).

**Negative / accepted**

- The worker must be kept awake by mechanisms that are not part of the WebExtensions spec's
  guarantees. This is the product's main reliability risk, which is why M0 exists and why the
  acceptance test idles for five minutes and asserts the worker never restarted
  (`worker.startsThisInstall` unchanged, session id unchanged).
- A worker restart loses the socket and any in-flight command. Accepted: the plan requires
  re-announce and no replay.
- If keepalive proves unreliable on real machines, the fallback is **native messaging** (ADR 0002,
  prior art). That is a transport swap behind the same supervisor, not a redesign of the protocol.

## Evidence required before this ADR is considered proven

- `npm run test:keepalive`: 5 minutes of no traffic, then `/health` answers from the bridge with the
  same session id and no additional worker start.
- The same, with Chrome's window occluded (M2 uses the same harness for reads).

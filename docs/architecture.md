# Architecture — Geeksblock Ava Browser Extension

Status: M5 (skeleton, handshake, keepalive, tabs, marker, reads, actions, adapter, audit and packaging). Product decisions: `IMPLEMENTATION-PLAN.md` §12.
Background: `docs/adr/0001-extension-as-background-browser-path.md`.

## Components

```
Ava / Cua ──▶ bridge (bridge/, Node, 127.0.0.1 only) ──WS + token──▶ extension (MV3, extension/)
                    │                                                     │
                    │ GET /health (loopback HTTP)                          ├─ service worker: socket, dispatch, supervisor
                    └─ gb-ava-bridge CLI                                  ├─ offscreen.html: 20 s keepalive tick
                                                                          ├─ options.html: token + human-owned switches
                                                                          └─ chrome.* API calls (M1+)
```

| Path | What it is | What it must never do |
| --- | --- | --- |
| `bridge/` | Loopback WebSocket server, token store, health endpoint, CLI | Bind anything but `127.0.0.1`; retry a command on its own |
| `extension/src/service-worker.ts` | Bridge client; executes supervisor effects; answers `health`/`settings.get` | Hold business rules in event handlers; raise a window |
| `extension/src/lib/supervisor.ts` | Pure connection state machine | Touch `chrome.*`, timers or sockets |
| `extension/src/lib/settings.ts` | Per-install token, bridge address, human-owned switches | Let the protocol write a setting |
| `shared/` | Wire contract, error taxonomy, redaction, fingerprint | Be duplicated by either side |

## Keepalive (the M0 risk)

MV3 suspends a service worker after ~30 s idle. The product premise — an agent quietly working in a
background tab — dies with it, so this is built and tested first (plan §10.3). Two independent
keepers:

1. **Offscreen document** (`offscreen.html`) sends `ava.keepalive.tick` every 20 s. Receiving a
   runtime message wakes the worker.
2. **`chrome.alarms` heartbeat** every 30 s (the MV3 minimum; sub-minute periods are honoured from
   Chrome 120, which is why the manifest's `minimum_chrome_version` is 120). Alarms survive worker
   death and are the reason a suspended worker still comes back.

On each tick the supervisor either pings the bridge (connected) or re-arms the reconnect loop
(`backoff` / `connecting`). Backoff is exponential from 500 ms to 30 s with ±20 % jitter
(`lib/backoff.ts`). Rejections (`unauthorized`, `protocol_mismatch`) move the machine to `blocked`
and stop retrying — a wrong token will not fix itself.

The socket lives in the worker, not the offscreen document: `chrome.tabs`/`scripting`/`debugger` only
exist in the worker, so a command arriving anywhere else would need a hop before doing anything.
Trade-off and alternatives: `docs/adr/0003-socket-ownership-and-keepalive.md`.

## Command handling

`health`, `settings.get`, `session.start`/`session.end` and the `tabs.*` set exist after M1. Every
parameter object is validated by the shared schema before a `chrome.*` call. The dispatcher enforces
two rules that matter for everything after it:

- a reserved-but-unbuilt method returns `not_implemented`, anything else `unknown_method`;
- an in-flight command is never replayed. The bridge fails every pending request with
  `extension_disconnected` when the socket closes; the worker cannot resurrect a socket that died
  with it.

## Tabs and the marker

- `lib/tabs.ts` decides which tabs match a predicate and which ids are still live; `lib/tab-ops.ts`
  performs the `chrome.*` calls; `service-worker.ts` only routes. The browser cannot be unit-tested,
  the decisions can, and that split is the reason the marker logic has 20 tests.
- `lib/marker.ts` is the visible marker as a pure state machine. Its tab set is authority; the group
  is a signal for the human and nothing branches on group membership. There is one group and its id
  is reused: creating a second one empties the first, and Chrome deletes an empty group.
- The grace ungroup is a `chrome.alarms` entry (`ava.ungroup-marker`, one minute) so it survives a
  suspended or killed worker; a reconnect inside the minute cancels it. It is an absolute deadline —
  arming it is idempotent, because every failed reconnect attempt reports the bridge as gone and a
  grace that restarted on each attempt would never expire (the integration test caught exactly that).
  A browser restart resets the marker through `chrome.runtime.onStartup`: tab and group ids from a
  previous run mean nothing, and ungrouping against them could pull unrelated tabs out of the human's
  own groups.
- Commands on one tab do not interleave: a second command on a tab that already has one in flight is
  refused with `tab_busy` (retryable), never queued.
- `tabs.navigate` answers only once the tab is at the requested URL (or a redirect of it) and
  `complete`. It deliberately does not wait on `chrome.tabs.onUpdated` alone: a background tab that
  finishes before the listener attaches would otherwise wait for an event that never comes again.
  Chrome refuses a background navigation *to* a `data:` URL, so `data:` is not an accepted scheme and
  the test fixtures are a real loopback origin.

## Reading a background tab

- `page.getText` uses `chrome.scripting`: cheap, no debugger, no infobar.
- `page.readAX` and `page.screenshot` need CDP, because `chrome.scripting` cannot see computed
  accessibility or pixels and `captureVisibleTab` only sees the visible window. `lib/debugger.ts`
  owns the session: one attach per tab, `debugger_unavailable` when another debugger owns it (a tab
  with DevTools open), every CDP call bounded at 5 s so the bridge's 10 s never wins the race, and a
  detach on tab close, on navigation and on worker suspension so the infobar does not linger.
- A read still answers when the debugger is unavailable: `page.readAX` falls back to a DOM-derived
  tree and reports `source: "scripting"`, because a degraded read beats a failed one — as long as the
  caller can tell.
- `lib/ax.ts` shapes the tree (bounded, noise-free, ignored wrappers walked through) and is pure, so
  the rules about depth, truncation and node ids are unit-tested. Every read result carries a
  `documentEpoch`: a node id is only valid in the document that produced it.
- `page.screenshot` reports `possiblyStale` by comparing with the previous capture of the same tab.
  Measured on Chromium 156 with the tab in the background: a DOM change appeared in the next capture.
  The flag stays because the compositor may lag, and the docs tell a caller that needs guaranteed
  structure to prefer `page.readAX`.

## Acting on a background tab

- Input is dispatched through CDP (`Input.dispatchMouseEvent`, `Input.insertText`,
  `Input.dispatchKeyEvent`): a background tab receives no OS events, and a synthetic browser-level event
  is the only thing that reaches it. The tab is still never activated.
- A target resolves to a box (`DOM.getBoxModel`, or `DOM.querySelector` then the same), is scrolled
  into view and re-measured before the click. `DOM.resolveNode` gives the object id that `select` and
  `upload` need.
- A modal dialog blocks the renderer, so any input sent while one is open simply never answers. The
  code tracks `Page.javascriptDialogOpening`/`Closed` and reports `needs_human` at the moment it
  happens, including a dialog that opened and closed inside the settle window — otherwise the caller
  would see a 5 s timeout and have no idea a human was needed.
- `page.download` listens for `chrome.downloads.onCreated` and polls until Chrome has resolved a path;
  `filename` can legitimately be empty while `state` is `in_progress`, and `finalUrl` identifies the
  download either way.
- Nothing retries. A timed-out click is an unknown outcome, and the protocol says so rather than
  guessing.

## The MCP surface

- `mcp/` is a stdio JSON-RPC server (one message per line) over the adapter. It owns no policy: it
  lists the tools, forwards a call, and turns a `NeedsHumanError` into an MCP tool error whose body
  says `needs_human`, the reason, and "ask the owner". A model host therefore sees a human-blocked
  action as a different kind of answer from a failure.
- `handleMessage` is a pure function of (message, client), so the protocol is unit-tested without a
  process; `runStdio` is the transport. An integration test spawns the real server against the real
  bridge and extension, which is the path a host takes.
- It is a local server on purpose: the bridge is loopback-only, the token is read from disk, and no
  secret appears in an agent's configuration file.

## The audit trail

- `lib/audit.ts` is a fixed-capacity ring (500) written by the one place that sees every command,
  `handleBridgeRequest`. It records method, tab, a summary, outcome, code and duration.
- The summary is built per argument, not by serialising the payload: `text` and `expression` become
  lengths, `files` a count, `png` a marker, and long strings are cut at 60 characters. That is what
  keeps page content and secrets out of the buffer by construction rather than by remembering to
  redact.
- `health.audit` exposes only the size and the last 20, so polling health cannot grow a response
  without bound.

## The adapter

- `adapter/` is a separate workspace package: `browser_*` tools over `BridgeClient`, which reads the
  per-install token from the config directory and speaks authenticated JSON to 127.0.0.1. It is a
  library, not a service — the caller runs it in-process, so nothing new listens.
- The adapter adds the two things a protocol cannot: a typed error split (`NeedsHumanError` with a
  reason versus `BridgeError` with the protocol's code) and `browser_read_page`, which returns text and
  the accessibility tree together because that is one decision for a caller.
- A CAPTCHA is only named when a marker is visible on the page; otherwise a stalled command stays a
  `timeout`. WebAuthn and permission prompts are not detectable at this layer yet, and the docs say so
  rather than mislabelling them.
- File choosers are intercepted at the page level (`Page.setInterceptFileChooserDialog`): a background
  tab cannot raise Chrome's picker, so the page waits, the event tells us, and `page.upload` answers it.

## Security boundary

- Loopback bind, extension-origin check on the socket and on every HTTP route, constant-time token
  compare, 0600 token file in `~/.config/gb-ava-bridge/` (re-asserted on every load).
- `POST /rpc` requires that token (`Authorization: Bearer` or `x-ava-token`); `GET /health` and
  `GET /version` are tokenless by design so a human can diagnose with `curl`. Decision and
  alternatives: `docs/adr/0004-http-surface-authentication.md`.
- Logs redact by key (`token`, `authorization`, …) and by value (the registered secret is replaced
  even inside a URL). The token is printed only by `gb-ava-bridge token`.
- The agent may read settings, never change them. `page.evaluate` is off until a human enables it in
  the options page (plan §5.1).
- `<all_urls>` + `debugger` mean the extension can read any signed-in page. Accepted in the ADR;
  stated in the README.

## Gaps closed since

This section used to list what the milestone did not yet do. All three of those gaps —
the Cua adapter (M4), the audit ring buffer and packaging/force-install (M5) — have since
shipped; the README status line carries the current position.

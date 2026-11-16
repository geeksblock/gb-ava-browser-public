# Protocol v1 — extension ⇄ bridge

Status: **implemented subset** — M0 ships the handshake, `health`, `settings.get` and the error
taxonomy. M1–M3 add the tab and page methods without changing the envelope.

Decision record: `IMPLEMENTATION-PLAN.md` §5 (and §5.1 for `page.evaluate`). Single source of truth
for the shapes: `shared/src/protocol.ts`. This document is the prose that a reviewer and the M4 Cua
adapter can read together.

## Transport

- One WebSocket per browser, dialled **by the extension** to `ws://127.0.0.1:<port>/extension`.
- The bridge binds `127.0.0.1` only and rejects any upgrade whose `Origin` is not
  `chrome-extension://<id>` (empty allowlist = accept any extension origin; an id allowlist narrows
  it). A web page that guesses the port still cannot connect.
- Token: a 256-bit per-install value from `gb-ava-bridge token`. It is **never sent** on either channel
  (ADR 0005): each side proves it holds it with HMAC-SHA256 over fresh nonces, the bridge first. It is
  never logged — logs carry an 8-hex-character fingerprint instead.
- Every HTTP request and upgrade must carry `Host: 127.0.0.1:<port>`, `localhost:<port>` or
  `[::1]:<port>`; anything else is `403` (DNS rebinding).
- The extension makes no other network request. There is no telemetry and no remote config.
- `POST /rpc` is the narrow local tool surface (the CLI, and the Cua-shaped adapter since M4). It **requires a
  fresh proof of the per-install token** (ADR 0005):
  1. `POST /auth/challenge` `{ "clientNonce": "<43 base64url chars>" }` →
     `{ "ok": true, "serverNonce": "…", "serverProof": "…" }`, where
     `serverProof = HMAC(token, "gb-ava/v2/rpc-server", clientNonce, serverNonce)`. The caller verifies
     it and stops if it fails: whatever answered does not hold the token.
  2. `POST /rpc` with `x-ava-nonce: <serverNonce>` and
     `x-ava-proof: HMAC(token, "gb-ava/v2/rpc-client", serverNonce, sha256hex(body))`. A nonce is single
     use (spent even on a wrong proof) and lives 30 s; at 1,024 outstanding the oldest is dropped.
  3. A `200` answer carries `x-ava-response-proof: HMAC(token, "gb-ava/v2/rpc-response", serverNonce,
     sha256hex(answer))`; callers refuse any 200, or any body claiming `ok: true`, without it.

  `HMAC(token, label, a, b)` is HMAC-SHA256 keyed with the token's UTF-8 bytes over
  `label + "\n" + a + "\n" + b`, base64url without padding. The raw token is **not** accepted as
  `Authorization: Bearer` or `x-ava-token` any more. The CLI, the adapter and the MCP server do all of
  this for the caller; a caller without a valid proof gets `401 unauthorized` and no command is forwarded.
- Every HTTP route refuses a request that carries an `Origin` other than the extension's own (the
  same policy as the socket upgrade). A browser always sends `Origin`; the CLI and a `curl` from a
  terminal send none, which is why they are still allowed.
- `GET /health` and `GET /version` stay tokenless so a human can diagnose with `curl`. They expose
  bridge state and whether the extension is connected, and can change nothing. The extension's own
  health (audit trail, dialog text) is served only to an authenticated caller, as `/rpc` method
  `health`; `gb-ava-bridge health` shows both.

## Envelope

Request:

```json
{ "id": "uuid", "method": "settings.get", "params": {} }
```

Success:

```json
{ "id": "uuid", "ok": true, "result": {} }
```

Failure:

```json
{ "id": "uuid", "ok": false, "error": { "code": "evaluate_disabled", "message": "…", "retryable": false } }
```

Rules that are enforced in code, not convention:

- `id` and `method` are required, non-empty, bounded (`128` / `64` chars). A malformed frame is
  rejected; no field is ever defaulted.
- Unknown method → `unknown_method`. A v1-reserved method that is not built yet →
  `not_implemented`. Both are errors. A reserved-but-unbuilt method never returns an invented
  default.
- No automatic retries anywhere. `click` and `type` are not idempotent, so an ambiguous outcome is
  reported, not replayed. `retryable` describes the *caller's* safety to retry, and is `false` for
  `timeout`, `extension_disconnected`, `tab_changed` and `needs_human`.
- Every method takes an explicit `tabId` or a URL predicate. There is no "current tab".
- Every `page.*` method refuses a tab showing a browser page (`chrome:`, `devtools:`, …), any extension
  page (including Ava's own settings) or a local file (`file:`) with `invalid_request`, before the debugger
  is touched (ADR 0005). `tabs.navigate` / `tabs.create` accept only `http:`, `https:` and `about:` URLs.

## Handshake

Protocol v2 (ADR 0005): four frames, the whole exchange within 5 s. The token is never sent; the
bridge proves it holds the token **before** the extension does, so whatever else might be answering on
the port learns nothing and is never obeyed.

Client → server, first frame:

```json
{ "type": "hello", "protocolVersion": 2, "clientNonce": "<43 base64url chars>", "client": { "name": "gb-ava-extension", "version": "0.1.0", "extensionId": "…", "resumed": false, "build": "5c996186c457", "builtAt": "2026-11-06T16:43:22.000Z" } }
```

Server → client, the bridge proves itself:

```json
{ "type": "hello_challenge", "serverNonce": "…", "serverProof": "HMAC(token, \"gb-ava/v2/ws-server\", clientNonce, serverNonce)" }
```

Client → server, only after the server proof verified:

```json
{ "type": "hello_auth", "clientProof": "HMAC(token, \"gb-ava/v2/ws-client\", clientNonce, serverNonce)" }
```

`client.build` / `client.builtAt` are the commit and time the extension bundle was built from.
They are optional only for an extension older than build stamping: a value that is present must be a
short (≤200), non-empty, single-line string, and the bridge refuses one that is not rather than
quoting it in a diagnostic later. The bridge's own build is reported by `GET /version` and `/health`, which is how a stale
unpacked extension (code on disk newer than the service-worker script Chrome is executing) becomes a
stated fact instead of a guess. See "Versioning".

Server → client, accepted:

```json
{ "type": "hello_ok", "protocolVersion": 2, "sessionId": "uuid", "server": { "name": "gb-ava-bridge", "version": "0.1.0" } }
```

Server → client, rejected: `{ "type": "hello_error", "error": { … } }` followed by a close with the
matching code.

Rules both sides enforce:

- Neither side acts on a request frame before `hello_ok`. The bridge closes a socket that sends one
  (4010); the extension ignores it.
- The extension treats a `hello_ok` that did not follow a verified challenge, a bad server proof, or a
  `hello_error` from a peer that never proved itself as **an unverified bridge**: it closes with 4011 and
  blocks (`blockedReason: bridge_unverified`) until a human acts. A wrong pasted token looks the same.
- Before authentication the bridge refuses frames over 4 KB, and at most 8 sockets may be
  mid-handshake; a ninth evicts the oldest (so idle sockets cannot lock the extension out). A refusal at this stage is recorded as
  `bridge.lastRejectedHandshake`, never as the extension's `lastError`: any local process can cause one.

| Close code | Meaning |
| --- | --- |
| 4001 | `unauthorized` — token rejected |
| 4002 | `protocol_mismatch` |
| 4003 | `badOrigin` — refused at the HTTP upgrade |
| 4008 | `handshakeTimeout` — no `hello` within 5 s |
| 4009 | `replaced` — a newer connection took over |
| 4010 | `malformed` — a frame out of turn, or not a valid handshake frame |
| 4011 | `serverUnverified` — *sent by the extension*: the peer could not prove the token |

A second authenticated connection **replaces** the first (4009) rather than being refused: a stale
socket must not be able to lock a browser out. The extension reports `resumed: true` when it has
handshaked before in this profile, which is how the bridge distinguishes a worker restart from a
fresh install.

## Liveness

`{ "type": "ping", "seq": n }` → `{ "type": "pong", "seq": n }`. The extension sends one on every
keepalive tick; the bridge answers. These are control frames, not methods.

## Methods

Reserved in v1 (plan §5), implemented today in **bold**:

**`session.start`**, **`session.end`**, **`health`**, **`settings.get`**, **`tabs.list`**,
**`tabs.query`**, **`tabs.navigate`**, **`tabs.group`**, **`tabs.ungroup`**, **`tabs.close`**,
**`tabs.activate`**, **`session.status`**, **`page.readAX`**, **`page.getText`**, **`page.screenshot`**, **`page.click`**, **`page.type`**,
**`page.key`**, **`page.scroll`**, **`page.select`**, **`page.upload`**, **`page.download`**,
**`page.waitFor`**, **`page.evaluate`** (gated, §5.1).

Every parameter object is validated against `shared/src/protocol.ts` before any `chrome.*` call: a
missing or mistyped required field, or a key the method does not accept, is `invalid_request` and the
command does not run. Unknown keys are refused rather than ignored, so a typo like `tabid` fails loudly
instead of silently listing every tab.

### The audit trail

Every command the extension executes is recorded in a 500-entry ring buffer, and `health.audit` returns
its size and the most recent 20 entries:

```json
{ "capacity": 500, "size": 12, "recent": [
  { "at": "2026-10-30T14:07:58.000Z", "method": "page.type", "tabId": 123,
    "args": "tabId:123 selector:#email text:18ch", "outcome": "ok", "code": null, "durationMs": 42 } ] }
```

The record holds the method, the tab, a bounded argument summary, the outcome (including
`needs_human`), the protocol error code and the duration. It holds **no page content** — no text, no AX
tree, no screenshot — and **no secrets**: `page.type` records a character count instead of the typed
text, `page.evaluate` records the expression's length, and a screenshot records only that there was
one. `health.audit` is bounded so polling it stays cheap.

A command the *bridge* refuses before forwarding — an unknown method at `/rpc`, a bad token, a wrong
origin — never reaches the extension, so it is in the bridge's own log rather than this ring. The ring
covers everything the extension saw, including commands it refused itself (`invalid_request`,
`needs_human`).

### `health`

Bridge-side: `GET http://127.0.0.1:<port>/health` returns the bridge block and whether the extension
is connected, with `extension.health: null`. The extension's own health below (audit, dialogs) is
served only through an authenticated `/rpc` call to method `health`; `gb-ava-bridge health` merges the
two into the view shown here, which is the single answer to "is Ava's browser path alive?" and the M0
acceptance signal.

```json
{
  "ok": true,
  "build": {
    "bridge": { "id": "5c996186c457", "builtAt": "2026-11-06T16:43:22.000Z" },
    "extension": { "id": "5c996186c457", "builtAt": "2026-11-06T16:43:22.000Z" },
    "mismatch": false
  },
  "bridge": { "name": "gb-ava-bridge", "version": "0.1.0", "protocolVersion": 2, "host": "127.0.0.1", "port": 8765, "uptimeMs": 0, "tokenConfigured": true, "tokenFingerprint": "1a2b3c4d", "socketsSeen": 1, "uploadDirectory": "/Users/…/Ava Uploads" },
  "extension": {
    "connected": true,
    "sessionId": "…",
    "client": { "name": "gb-ava-extension", "version": "0.1.0" },
    "health": {
      "worker": { "startedAt": "…", "uptimeMs": 0, "startsThisInstall": 1, "phase": "connected" },
      "keepalive": { "offscreenDocument": true, "alarmScheduled": true, "ticksReceived": 0, "reconnect": { "attempts": 0 } },
      "session": { "id": "…", "protocolVersion": 2 },
      "extension": { "name": "Geeksblock Ava Browser Extension", "version": "0.1.0", "id": "…", "build": "5c996186c457", "builtAt": "2026-11-06T16:43:22.000Z" },
      "settings": { "evaluateEnabled": false, "evaluateEnabledBy": "human" },
      "lastError": null
    }
  }
}
```

When the extension is not connected the block is `{ "connected": false, "lastError": { … } }` — the
bridge always answers its own health.

`build` is the stale-build detector. `bridge` is the build of the bundle answering this
request, `extension` is what the connected extension reported in its `hello` (null when none is
connected, or when the extension predates build stamping), and `mismatch` is true only when both
stamps are present and differ. `builtAt` is null if a side reports a build id without a timestamp,
in which case the ordering is unknown and the diagnosis below names both builds instead of guessing.

A mismatch means one side is running an older build, and either side can be the stale one:

- **the extension**, because Chrome can keep serving the service-worker script it cached at the
  extension's last load, even across a browser restart → reload the unpacked extension at
  `chrome://extensions`; a Chrome restart does not refresh it;
- **the bridge**, because the bridge is a long-lived process (a login service that keeps it running
  survives rebuilds) and keeps the bundle it started with → restart the bridge: stop and start
  `gb-ava-bridge serve`, or restart the login service that runs it.

When both timestamps are present the reply names the older side.

### `settings.get`

Returns the owner's settings that the agent is allowed to read. Read-only: nothing in this protocol
can change a setting (plan §6, "the options page is not agent-writable").

```json
{ "evaluateEnabled": false, "evaluateEnabledBy": "human" }
```

`page.evaluate` with `evaluateEnabled: false` returns `error.code = "evaluate_disabled"` and the
one-line hint `Enable 'Allow page.evaluate' in the Ava extension settings`. It never silently falls
back to another method.

In M0 nothing implements `page.evaluate` yet, so the bridge answers `not_implemented` for it; the
`evaluate_disabled` branch lands with the method itself (M3). Both are errors, neither is a silent
success.

### Tabs (M1)

`tabs.list`, `tabs.query`, `tabs.navigate`, `tabs.create`, `tabs.group`, `tabs.ungroup`, `tabs.close`,
`tabs.activate`.

A tab the agent addresses is always named explicitly, or resolved by a predicate. There is no
"current tab": a background agent has no focus to borrow.

```json
// tabs.list  { "groupId"?: number, "windowId"?: number, "limit"?: 1..200 }
// tabs.query { "urlPattern"?: string, "titleContains"?: string, "groupId"?: number,
//              "windowId"?: number, "active"?: boolean, "pinned"?: boolean, "limit"?: 1..200 }
{ "tabs": [ { "tabId": 123, "windowId": 45, "index": 2, "active": false, "pinned": false,
              "url": "https://…", "title": "…", "status": "complete", "groupId": -1 } ],
  "count": 1 }
```

- `url` is `null` for a tab the extension may not read (`chrome://`, `chrome-extension:`, `edge://`,
  `about:`), and a `urlPattern` never matches such a tab.
- `urlPattern` and `titleContains` are case-insensitive **substrings**, not regular expressions.
- Results are capped by `limit` (default 50, maximum 200), so a large window cannot flood the model.

```json
// tabs.navigate { "tabId": 123, "url": "https://…" }
{ "tabId": 123, "url": "https://…", "title": "…", "status": "complete", "marker": { … } }
```

`tabs.navigate` navigates **without focusing** the tab, and answers once the tab reports `complete`
at the requested URL (or a redirect of it). It never replays a navigation: a page that has not loaded
in 8 s answers `timeout` with `detail.status` / `detail.url` so the caller can decide. A tab that
closes mid-navigation is `not_found`. Schemes that a page cannot be (`chrome:`, `javascript:`) are
refused with `invalid_request` before anything moves.

```json
// tabs.group   { "tabIds": [123, 124], "groupId"?: number }
// tabs.ungroup { "tabIds": [123] }
// tabs.close   { "tabId": 123 }
```

`tabs.ungroup` removes the marker but leaves the tabs open. `tabs.close` closes one explicit tab.
Two commands on the same tab never interleave: the second is refused with `tab_busy` (retryable).

```json
// tabs.activate { "tabId": 123, "focusWindow"?: false }
{ "tabId": 123, "activated": true, "windowId": 7, "windowFocused": false,
  "windowRaised": false, "wasActive": false }

// session.status {}   — no parameters
{ "sessionId": "…", "active": true, "drivenTabIds": [123], "presentTabIds": [123],
  "missingTabIds": [], "attachedTabIds": [123], "marker": { … } }
```

```json
// tabs.create { "url": "https://…", "windowId"?: 45, "background"?: true, "pinned"?: false }
{ "tabId": 124, "url": "https://…", "title": "…", "status": "complete" }
```

`tabs.create` opens a tab without leaving the bridge. `background` defaults to **true**: the tab is
created with `active: false`, so Chrome neither switches to it nor raises its window. That is what
makes this method worth having — the alternative, driving the desktop, brings Chrome to the front and
gives up the no-focus-theft guarantee for that step. Pass `background: false` only when the caller
wants the tab focused. The reply arrives once the page has landed, judged by the same rule
`tabs.navigate` uses, so a created tab and a navigated one are equivalent from then on.

`tabs.activate` selects the tab in its window. It is **not** a focus steal: selecting a tab does not
raise its window, which is why the reply reports `windowRaised` and the default is `false`. It exists
for the sites that only render or only respond on the active tab, and for handing a page to a tool that
can only see the active tab of a window (a GUI driver reading the window's accessibility tree). The
marker prunes a tab the moment Chrome reports it closed, so `missingTabIds` is normally empty; it is
the guard for a session that outlived its tab. `attachedTabIds` lists the tabs holding a CDP session,
which is the cheapest way to see what is attached without reading logs.

### Reading a tab (M2)

`page.readAX`, `page.getText`, `page.screenshot`. All three read a tab that is **not** in front; none
of them brings it forward.

```json
// page.readAX { "tabId": 123, "limit"?: 1..4000, "includeInvisible"?: false }
{ "tabId": 123, "url": "https://…", "title": "…", "source": "debugger",
  "nodes": [ { "nodeId": 101, "role": "textbox", "name": "Email", "value": null,
               "visible": true, "disabled": false, "focused": false, "checked": null,
               "bounds": { "x": 10, "y": 20, "width": 300, "height": 24 }, "childCount": 0 } ],
  "totalNodes": 41, "truncated": false }
```

- `nodeId` is Chrome's backend DOM node id — the handle `page.click` addresses in M3. It is `null`
  rather than invented when Chrome gives none.
- Generic wrappers are walked *through*, not stopped at, and not reported: Chrome marks them ignored
  while their children are the real content.
- `bounds` is CSS pixels, or `null` for a node with no box.
- `limit` defaults to 400; `truncated` says whether the tree was cut.
- `source` is `"debugger"` (CDP accessibility tree) or `"scripting"` (a DOM-derived fallback used when
  another debugger — typically the tab's DevTools — owns the tab). A fallback read has no geometry and
  coarser roles, and it says so.
- `documentEpoch` moves whenever the tab's document changes. A `nodeId` is only valid in the document
  that produced it, so a caller comparing epochs before acting can tell that its node is stale.

**Frames.** A CDP session attached to a tab does not cross an out-of-process iframe, and Microsoft
Entra / the M365 admin center render every blade inside one. A read that stopped at the tab's own
document therefore answered the portal shell — `length: 270, truncated: false`, no error — and the
answer was only reachable by screenshot. Both reads now cover child frames:

- `page.readAX` returns the tab's own document from CDP and, for each child frame, a DOM-derived
  list read from **inside** that frame. A node from a frame has `nodeId: null`, a `frame` index and a
  `selector` that is unique in its own frame — address it by `selector` (`page.click` resolves the
  frame for you). Its `bounds` are relative to that frame's viewport.
- The reply names every frame it read in `frames` (`index`, `url`, `title`, `nodes` — how many of
  that frame's nodes are in *this* reply — and `source`) and
  every frame it could not read in `framesNotRead` with a reason. Nothing is dropped silently.
- `page.getText` returns the page text section by section, each child frame introduced by
  `[frame <index>: <url>]`, plus the same `frames` / `framesNotRead` summary.
- Fidelity is labelled: the tab's document is a real accessibility tree, a frame's node list is a
  scripted DOM walk (`source: "scripting"`) with coarser roles. A framed node's `selector` is either
  unique in its frame or `null` — never a path that matches several elements. `page.waitFor` on a
  selector also searches frames.
- A selector that matches in **two different frames** is refused with `invalid_request` and the frame
  URLs in `detail`, because choosing one would click the wrong element and answer `ok`.
- Not yet routed into frames: `page.select` and `page.upload`. Both address an element through the
  tab's CDP session, so an element inside a child frame is reported as `not_found` rather than
  silently missed.

```json
// page.getText { "tabId": 123, "limit"?: 1..200000 }   — characters, default 20000
{ "tabId": 123, "text": "…\n\n[frame 1: https://…]\n…", "length": 812, "truncated": false,
  "source": "scripting", "documentEpoch": 3,
  "frames": [ { "index": 0, "url": "https://…", "title": "…", "characters": 540 } ],
  "framesNotRead": [] }
```

`page.getText` is the cheap read: `chrome.scripting`, no debugger, no infobar. A truncated read carries
`…[truncated N characters]` at the end and `truncated: true`, so a caller never reasons about half a
page as if it were whole. `length` is the length of the **full** page text, before truncation, so it
does not equal `text.length` when `truncated` is true.

```json
// page.screenshot { "tabId": 123, "detectStale"?: false }
{ "tabId": 123, "png": "iVBORw0…", "bytes": 51234, "width": 1280, "height": 800,
  "possiblyStale": false, "source": "debugger", "documentEpoch": 3 }
```

`page.screenshot` captures the **tab**, not the window, through CDP (`Page.captureScreenshot`), so it
works with the tab in the background. The image is capped at 6,000,000 base64 characters; a bigger one
is an error rather than a silently truncated PNG.

**On freshness.** Chrome composites a background tab lazily, so a capture *can* return a frame that no
longer matches the DOM. With `detectStale: true` the bridge compares this capture byte-for-byte with
the previous capture of the same tab; identical bytes are reported as `possiblyStale: true` rather than
presented as fresh. That is a definition, not a guarantee: an unchanged page is also identical, so the
flag means "this may be the frame you already had", never "this is current".

Measured on Chromium 156 (macOS): with the tab in the background and another tab in front, and again
with another application frontmost, a DOM change was reflected in the next capture — so in practice a
background capture was fresh here. The flag stays because the compositor may lag, and the advice
stands: when structure must be current, prefer `page.readAX` and check `documentEpoch`.

### Acting on a tab (M3)

`page.click`, `page.type`, `page.key`, `page.scroll`, `page.select`, `page.upload`, `page.download`,
`page.waitFor`. All of them act on a tab that is **not** in front: a background tab receives no
operating-system events, so input is synthesized.

**Pointer input has two routes, and the extension picks one from observed state before dispatching.**

A background tab does not get CDP mouse events applied: Chrome does not ack
`Input.dispatchMouseEvent` for a renderer it is not compositing, so the command times out and the click
never happened. Keyboard events, DOM commands and `Runtime` calls are acked on another path and do
work, which is why a background tab could be read and typed into but not clicked.

- When the tab is active in a focused window and the page reports `visibilityState: visible`, the click
  goes through CDP — Chrome's own input pipeline.
- Otherwise (hidden page, tab not active, window not focused) the full pointer/mouse sequence is
  dispatched **inside the page** from the resolved element, which the renderer answers immediately.
  `click` is the last of those events, so an element's default action (an anchor navigating, a submit
  button submitting) still runs.

The reply says which route ran in `input.route` — `cdp`, `scripted`, or `frame` when the element is
inside a child frame (and `page` for `page.scroll`, which always scrolls in the page) — with
`input.reason`, and
`inputRoute` on `page.click`/`page.type` forces one (`auto` is the default). The route is chosen
**before** dispatching, never by retrying after a timeout: a retried click can submit twice.

A target is exactly one of: an AX `nodeId` from `page.readAX` (preferred — it survives reflows), a CSS
`selector`, or `x` and `y`. Two kinds at once is `invalid_request`, not "prefer the first". The element
is scrolled into view and re-measured before the click: a box measured off-screen is a click into
nothing.

```json
// page.click { "tabId": 123, "nodeId": 101 }            (or "selector", or "x"+"y")
{ "tabId": 123, "clicked": { "x": 140, "y": 96 }, "queuedBehindDialog": false,
  "input": { "route": "scripted", "reason": "the tab is not the active tab in its window" },
  "needsHuman": null, "documentEpoch": 3 }

// page.type { "tabId": 123, "selector": "#email", "text": "…", "clear": true, "pressEnter": true }
// page.key  { "tabId": 123, "key": "Enter" | "Tab" | "Escape" | "ArrowDown" | …, "modifiers": ["meta"] }
// page.scroll { "tabId": 123, "deltaY": 400 }                          (no target needed)
// page.scroll { "tabId": 123, "deltaY": 400, "nodeId": 101 }           (that element's scroller)
// page.select { "tabId": 123, "selector": "#colour", "value": "green" }
// page.upload { "tabId": 123, "selector": "#file", "files": ["/abs/path"] }   (absolute paths)
// page.download { "tabId": 123, "selector": "#dlink", "timeoutMs": 10000 }
// page.waitFor { "tabId": 123, "selector": "#code", "text": "…", "urlIncludes": "/done", "timeoutMs": 8000 }
```

- Nothing is retried. A click that timed out may or may not have happened, and re-clicking a submit
  button is worse than reporting the ambiguity. A CDP click that times out reports what landed:
  `detail.acked` lists the mouse events the renderer answered (`mouseMoved`, `mousePressed`,
  `mouseReleased`), so a caller can tell "certainly nothing" from "probably landed".
- `page.scroll` scrolls **inside the page**, so it works on a background tab where a wheel event would
  not. With no target it moves the page's own scroller; with `nodeId`/`selector` it moves that
  element's nearest scrollable ancestor (reaching content below the fold of a pane); with `x`/`y` the
  element under the point decides. It answers `scrolled.container`, `before`/`after` positions and
  `atLimit`, so a scroll that did nothing is visible as `moved: false` rather than assumed.
- A modal JavaScript dialog is answered as `needs_human` with `detail.reason: "javascript_dialog"`
  rather than waited out: the dialog blocks the renderer, so any action sent while it is open never
  answers. That covers every action, not only clicks — the session tracks dialogs per tab, arms Page
  events on attach, and clears them when the tab navigates, closes or the session detaches. A click
  that opens one returns `queuedBehindDialog: true` — the press landed, and the next thing the caller
  must do is ask a human. `health.dialogs` shows what is open, by tab.
- `page.select` sets the value and fires `input`/`change`, the way a user's choice does; an option that
  does not exist is `invalid_request` with the available options in `detail`. A success reports the
  control it touched as `matched` (`tag`, `id`, `name`, `ariaLabel`, `options`), so a caller can log or
  assert on what it acted on rather than trusting the selector.
- `page.select` **refuses an ambiguous selector**. A selector matching more than one element is
  `invalid_request`, with `detail.matchCount` and up to five described candidates in `detail.matches`
  (`tag`, `id`, `name`, `ariaLabel`, `text`, `visible`) — the metadata needed to build a selector that
  addresses one control. Taking the first match silently is what made a bare `select` hit a theme
  picker instead of the contact picker on a real portal. `page.click` and `page.type` keep
  first-match resolution: a repeated selector there is usually intended (one button per row), and
  refusing it would break ordinary flows.
- `page.upload` attaches files **only from the bridge's upload folder** (`~/Ava Uploads` by default;
  `uploadDirectory` in the bridge `config.json`; ADR 0005). The bridge resolves symlinks and `..` with
  `realpath`, refuses anything outside the folder (or everything, if no folder is configured), and
  forwards the real paths. It then attaches them with `DOM.setFileInputFiles` — a real file-picker result,
  no dialog, and it works on a hidden input (the usual styled-label pattern), because it does not need
  a box. Chrome does **not** refuse a path that does not exist: it manufactures a zero-byte `File`
  named after the path and reports no error, so the page really does receive a ghost. The adapter
  therefore stats each path in Node before the bridge is asked and refuses a missing, unreadable or
  directory path with `invalid_request` — the extension cannot make that check, because Chrome gives
  it no way to tell a ghost from a real empty file.
- A `selector` searches the light tree; an element inside a shadow root must be addressed by the
  `nodeId` from `page.readAX`, which sees it. A node from a **child frame** has `nodeId: null` and a
  `selector` instead: address it with that selector (the frame is resolved for you), not with an id.
- `page.download` clicks and reports the download Chrome created (`id`, `state`, `filename`, `finalUrl`,
  `mime`). Chrome resolves the target path asynchronously, so `filename` can be empty while `state` is
  `in_progress`; `finalUrl` identifies it either way. The file goes to the profile's normal download
  folder.
- `page.waitFor` polls (selector, page text, URL) until the timeout and then answers `timeout` with
  what it last saw, so the caller learns which condition failed.
- `page.evaluate` runs only when a human has switched it on in the extension's options page; otherwise
  it is `evaluate_disabled` with the hint. Its result is bounded (4,000 characters, with `truncated`
  when cut), and a thrown expression is an error carrying the thrown message, never a `null` result.

### The marker

`session.start` begins a marked session; a tab joins the marker when it is grouped explicitly or
navigated during a session. The group is **`red`**, titled exactly **`Ava`**, with no icon and no
other text (plan §4), and `health` reports it as Chrome currently sees it:

```json
// session.start { "tabIds"?: [123] }        session.end {}
{ "sessionId": "…", "ungroupedTabIds": [123],
  "marker": { "sessionId": "…", "tabIds": [123], "color": "red", "title": "Ava",
              "group": { "groupId": 7, "color": "red", "title": "Ava", "collapsed": false } } }
```

The marker ungroups on `session.end`, when its last tab closes, and one minute after the bridge
disconnects. That grace is a `chrome.alarms` entry, so it survives the service worker being suspended
or killed; it is an absolute deadline rather than a rolling one, so failed reconnect attempts do not
extend it. A reconnect inside the minute cancels it. A browser restart ends every session and resets
the marker, because tab and group ids do not outlive a browser run.

The label the human sees in the tab strip is Chrome's group label: it exists only while a tab belongs
to the group, and it disappears when the group empties (Chrome deletes an empty group). Starting a
session with no tab ids therefore paints nothing visible, and the first tab must be grouped before it
is driven.

The marker is a visible signal for the human and **never load-bearing**: no decision reads group
membership back from Chrome, and `health.marker.group` is read live so a group the human dissolved by
hand is never reported as present.

### `needs_human` — what is detected, and what is not

A command that cannot finish because a person must act returns `needs_human` with
`detail.reason`. The reason is only ever one the extension can justify from evidence:

| Reason | How it is detected | Effect |
| --- | --- | --- |
| `javascript_dialog` | `Page.javascriptDialogOpening`/`Closed` on that tab's session | every action on that tab refuses until it is dismissed; the click that opened it returns `queuedBehindDialog: true` |
| `file_picker` | `Page.fileChooserOpened`, with interception enabled **only while an agent action is in flight** — a background tab cannot raise Chrome's picker, and leaving interception on would swallow the owner's own clicks | reported as `needsHuman` in the click reply and in `health.dialogs.fileChooser`; `page.upload` on that input satisfies it |
| `captcha` | the adapter's stall classifier, only when a CAPTCHA marker is visibly present | reported instead of a bare `timeout` |
| `webauthn` | **not yet detected** | the sheet does not block the renderer, so the action returns normally and only a later `waitFor`/`navigate` sees a page that never finishes |
| `permission_prompt` | **not yet detected** | same: the action succeeds, the page waits |

The last two are the honest gap. Naming them needs a signal Chrome does not currently expose at this
layer, so the protocol reports what it can see — a normal reply, or a later `timeout` — rather than
guessing a reason in their place. A `needs_human` without a recognised reason arrives at the adapter as
`reason: "unknown"`; nothing is ever rewritten into a reason the caller might act on wrongly.

## Error codes

`invalid_request`, `unknown_method`, `not_implemented`, `unauthorized`, `protocol_mismatch`,
`not_found`, `tab_changed`, `tab_busy`, `needs_human`, `debugger_unavailable`, `evaluate_disabled`,
`extension_disconnected`, `timeout`, `internal`.

`needs_human` carries `detail.reason` ∈ `webauthn`, `permission_prompt`, `javascript_dialog`,
`file_picker`, `captcha`. A system sheet is reported, never dismissed by the extension.

`unknown_method` and `not_implemented` from the extension carry `detail.extensionBuild` and
`detail.extensionBuiltAt`. The bridge compares that stamp with its own build before answering:

- **stamps differ** — the message and `detail.hint` say one side is stale, name both builds and,
  when `builtAt` is parseable on both, which side is older. The extension is refreshed by reloading
  it at `chrome://extensions`; the bridge is refreshed by restarting the process. `detail.olderSide`
  is `"extension"`, `"bridge"` or `null` (order unknown).
- **extension reports no stamp** — it predates build stamping; reload it.
- **stamps are equal** — explicitly *not* called stale: `unknown_method` is a real code bug, and
  `not_implemented` is genuinely reserved-but-unbuilt.

A method outside protocol v1 is rejected by the bridge itself, before the extension sees it; that
reply carries `detail.bridgeBuild`/`detail.bridgeBuiltAt` and a hint that a newer client should
restart the bridge. Without these, a stale side reproduces the original failure with no evidence,
which is exactly how it was misdiagnosed before.

## Versioning

The protocol version is an integer in `hello` and in every `health` payload. A mismatch is refused
at the handshake (4002) rather than being tolerated; both sides ship from this repo, so drift means
a stale unpacked extension, which the operator should reload. Version 2 (ADR 0005) replaced the token
in `hello` with the mutual proof. A v1 extension meeting a v2 bridge gets `protocol_mismatch` (4002);
a v2 extension meeting a v1 bridge cannot verify it and blocks as `bridge_unverified`.

The protocol version alone cannot catch a stale build: every build of this repository reports version
`0.1.0`, so an extension can be months behind and still negotiate the same protocol version. Build identity is a
separate, finer signal: `hello` carries `client.build`/`client.builtAt`, `health` groups both
sides under `build` with `mismatch`, and `GET /version` carries the bridge's own stamp flat
(`build` + `builtAt`). The bridge logs a warning at handshake when the stamps differ, and turns an
`unknown_method`/`not_implemented` from a differently-built extension into that diagnosis.

After `npm run build` both artefacts on disk change, but neither running side refreshes itself: an
unpacked extension keeps the service-worker script Chrome cached at its last load (a browser restart
does not refresh it), and the bridge process keeps the bundle it was started with. Reload the
extension at `chrome://extensions` **and** restart the bridge; then `/health` should report
`mismatch: false`.

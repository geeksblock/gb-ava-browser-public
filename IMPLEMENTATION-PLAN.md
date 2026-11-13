# Implementation Plan — Geeksblock Ava Browser Extension

Owner: Elias Hernandez (Geeksblock LLC) · Authorised 2026-10-29 · Written by Ava
Repo: `geeksblock/gb-ava-browser` · Product name: **Geeksblock Ava Browser Extension** · Tab group label: **Ava**, colour **red**

---

## 1. Outcome

Ava can operate a tab in Elias's own Chrome profile, in the background, while he keeps working in another window — with no "Allow remote debugging?" prompt, no window raising, and no focus theft.

**Definition of done (acceptance):** with Chrome behind a full-screen app, Elias asks Ava to check a client's Microsoft Entra configuration. Ava groups the tab red/`Ava`, navigates, signs in using a TAP, reads the blade content, reports it, and ungroups the tab — while Elias's front window never changes and his pointer is not moved.

## 2. Why this exists

Three possible doors into a browser, from the ADR:

| Door | Blocker |
| --- | --- |
| Remote-debugging port (today's Cua `browser_*` path) | Chrome must front itself for the consent prompt; only works on the profile Chrome was launched with |
| Accessibility / CGEvent (desktop layer) | Window must be on-screen and able to be raised; no DOM access |
| **Extension with `tabs` + `scripting` + `debugger`** | **None at action time** — acts per-tab, silently |

The extension is therefore the only background-capable path into the owner's real session. Full rationale and rejected alternatives: `docs/adr/0001-extension-as-background-browser-path.md`.

## 3. Architecture

```
 Ava (LLM, remote)  ──MCP──▶  Cua host (local)
                                 │  bridge: ws://127.0.0.1:<port>  (token auth)
                                 ▼
                        ┌────────────────────────┐
                        │ Extension service      │   MV3 service worker
                        │ worker (Ava Bridge)    │   ─ keeps WS alive (offscreen doc + alarm)
                        └───────────┬────────────┘   ─ command dispatch, tab marker, audit ring buffer
                                    │ chrome.* APIs (per tab, no focus)
                    ┌───────────────┼────────────────┐
                    ▼               ▼                ▼
              chrome.tabs    chrome.scripting   chrome.debugger → CDP
              (list/group/    (read-only DOM,   (AX tree, input,
               navigate)       text, styles)     screenshot, upload)
```

Three deliverables:

1. **Extension** (`extension/`) — MV3, TypeScript, no framework. Service worker only; no content scripts in v1.
2. **Bridge** (`bridge/`) — Node (TypeScript) local WebSocket server, owned by whoever hosts Cua. Speaks a small JSON-RPC to the extension and exposes a narrow tool surface to Ava/Cua.
3. **Cua adapter** (`bridge/src/cua-adapter.ts`) — implements the same call shape as Cua's `browser_*` tools so the agent side can choose a backend without new prompts.

### Transport decision

**Primary: WebSocket from the service worker to `ws://127.0.0.1`.** The bridge is a normal local process Cua already runs; no per-OS host registration.
**Rejected for v1: native messaging.** It needs a host binary registered per browser per OS and one manifest per extension id; heavier to install on client machines, and it cannot be initiated by a non-browser process.
**Consequence to design for:** MV3 service workers are suspended after ~30s idle. Keepalive is a hard requirement, not an optimisation: an offscreen document plus a `chrome.alarms` heartbeat, with a reconnect loop and exponential backoff. If the worker dies mid-command, the command fails explicitly (never silently retried — a click is not idempotent).

### Permissions (each one justified; adding any other needs an ADR)

| Permission | Why |
| --- | --- |
| `tabs`, `tabGroups` | Enumerate tabs, navigate, create the red `Ava` marker |
| `scripting` | Read-only DOM access without the debugger infobar |
| `debugger` | Accessibility tree, input dispatch, tab screenshot, file upload |
| `storage` | Bridge token, audit ring buffer, last-known state |
| `alarms`, `offscreen` | Service-worker keepalive and reconnect |
| `downloads` | Save agent-triggered downloads to a known folder |
| `host_permissions: <all_urls>` | Any client portal; per-origin grants are unusable for an agent that must reach arbitrary tenant domains |

Deliberately **not** requested in v1: `cookies` (no secret exposure), `webRequest`, `notifications`, `identity`, `unlimitedStorage`.

## 4. Tab marker specification

- On `session.start`: `chrome.tabs.group({tabIds:[tabId]})` then `chrome.tabGroups.update(groupId, { color: "red", title: "Ava" })`.
- The group is **red** and titled exactly **`Ava`** — no icons, no emoji, no other text. One group per browser; tabs join it as they are touched.
- On `session.end`, on tab close, and on bridge disconnect with a grace period: `chrome.tabs.ungroup`.
- The marker is cosmetic and must never be load-bearing for control: no logic may depend on group membership.
- Chrome's own "Ava started debugging this browser" infobar will also appear while the debugger is attached. Do not try to hide it; do not confuse it with the group.

## 5. Protocol v1 (sketch — final shape in code review)

Envelope: `{ "id": uuid, "method": string, "params": object }` → `{ "id", "ok": true, "result" }` or `{ "id", "ok": false, "error": { code, message, retryable } }`.

Methods: `tabs.list`, `tabs.query`, `tabs.navigate`, `tabs.group`, `tabs.ungroup`, `tabs.close`, `page.readAX`, `page.getText`, `page.screenshot`, `page.click`, `page.type`, `page.key`, `page.scroll`, `page.select`, `page.upload`, `page.download`, `page.waitFor`, `session.start`, `session.end`, `health`, `settings.get`, and `page.evaluate` (**gated — see 5.1**).

Rules:

- Every method takes an explicit `tabId` or resolves one from a URL predicate — never "the current tab".
- `page.click` accepts a target selector, an AX node id from a prior `readAX`, or coordinates — in that order of preference. Prefer AX ids; they survive reflows.
- `page.screenshot` returns a PNG of that tab, not the window.
- A command that cannot complete because a human must act returns `error.code = "needs_human"` with `detail.reason` ∈ {`webauthn`, `permission_prompt`, `javascript_dialog`, `file_picker`, `captcha`}. Never auto-dismiss a system sheet.
- Unknown method → hard error (fail closed), not a silent no-op: `unknown_method` for a name that is
  not in v1, `not_implemented` for a v1 method whose milestone has not landed. `page.evaluate` when
  the owner has not enabled it → `evaluate_disabled` (§5.1). The implemented subset, close codes and
  full error taxonomy live in `docs/protocol.md` and `shared/src/protocol.ts`.

### 5.1 `page.evaluate` — present, but off by default

Arbitrary JS is the most powerful and least predictable method, so it exists behind a **human-controlled switch**, not a code-level exclusion (owner decision 2026-10-30):

- **The toggle lives in the extension's options page** (`options_ui`) and is stored in `chrome.storage.local`. Default: **off**.
- **Only the human flips it.** The agent can read it (`settings.get`, and `health` reports it) but must never enable it for itself — that would be authority creep.
- When off, `page.evaluate` returns `error.code = "evaluate_disabled"` with a one-line human-readable hint ("Enable 'Allow page.evaluate' in the Ava extension settings"), so the agent can tell the owner what to do instead of guessing.
- When on, it still obeys the house rules: results are bounded (truncate and say so), the call appears in the audit ring buffer with a truncated argument summary, no retries, and any value the caller marks `sensitive` is never logged.
- The switch is per-install and per-browser. Changing it takes effect on the next command; it must not require a restart or a reconnect.
- Rationale: default-safe posture (no hidden side effects, no silent workarounds) without losing the escape hatch when a site genuinely needs it. It is one code path either way, so keeping it in the protocol costs nothing.

## 6. Security and privacy

- **Token:** the bridge generates a per-install random token; the user pastes it into the extension once. Stored in `chrome.storage.local`. Never logged, never in the repo.
- **Loopback only:** the bridge binds `127.0.0.1`; reject non-loopback peers, and reject any `Origin` header that is not the extension's — on the socket **and** on every HTTP route. `POST /rpc` additionally requires the per-install token (`Authorization: Bearer` or `x-ava-token`); `GET /health` and `GET /version` stay tokenless so a human can diagnose with `curl`.
- **Audit:** ring buffer (last 500 commands) of method, tabId, truncated argument summary (≤200 chars), outcome, duration. No page content, no typed secret values unless the caller marks a field `sensitive`.
- **No egress:** the extension makes no network requests except the local socket. No analytics, no remote config.
- **Reads are cheap, writes are deliberate:** `page.click`/`page.type` require an explicit tab; the extension never retypes a field it believes already has content.
- **Arbitrary JS is opt-in and human-owned:** `page.evaluate` runs only when the owner has enabled it in the extension options page (§5.1). The agent may read the setting; it may not change it.
- **The options page is not agent-writable:** nothing in the protocol can alter extension settings. If Ava needs a setting changed, it asks.

## 7. Failure modes to handle explicitly

| Failure | Required behaviour |
| --- | --- |
| DevTools already open on the target tab | `chrome.debugger.attach` fails; fall back to `scripting` for reads, report `debugger_unavailable` for actions |
| MV3 worker suspended mid-session | Reconnect, re-announce tabs, mark session `degraded`; do not replay the last command |
| Tab navigates away mid-command | Command fails with `tab_changed`; no retry |
| Chrome window minimised / occluded | Reads and input must still work (this is the whole point); screenshots may be stale — verify in M2, and if stale, prefer `readAX` and say so |
| Extension updated/reloaded | Bridge re-handshakes; in-flight commands fail loudly |
| Two sessions want the same tab | Refuse the second with `tab_busy`; never interleave input |

## 8. Testing

- **Unit** (vitest): protocol validation, group lifecycle, keepalive state machine, error taxonomy.
- **Integration**: Playwright launches Chromium with the extension loaded (`--load-extension`) and drives the bridge, not the page — proves the extension path works with zero CDP from the test side.
- **The acceptance test from §1**, run twice: once with the target tab focused, once with a different app frontmost. The second run is the real gate.
- **Regression for the marker:** assert `chrome.tabGroups.get(groupId).color === "red"` and `.title === "Ava"`.

## 9. Milestones

| # | Deliverable | Acceptance |
| --- | --- | --- |
| M0 | Repo scaffold, MV3 skeleton, WS hello handshake, token, keepalive | Worker survives 5 min idle; `health` answers from the bridge |
| M1 | `tabs.*` + red `Ava` group + ungroup lifecycle | Tabs group/ungroup correctly; colour and title asserted |
| M2 | Reads: `readAX`, `getText`, `screenshot` on a **background** tab | Reads succeed with Chrome occluded; screenshot staleness measured and documented |
| M3 | Actions: navigate, click, type, key, scroll, upload, download, waitFor | Can complete a real Entra sign-in (TAP) on a background tab |
| M4 | Cua adapter + agent-side switch, `needs_human` surfacing | The §1 acceptance test passes end to end |
| M5 | Hardening: audit log, permission/consent mapping, Enterprise force-install policy, packaging | Installs via Chrome policy on a managed test device |

## 10. Risks

1. **Screenshot of background tabs may be stale/blank** (compositor). Mitigation: prefer AX reads; validate in M2; document the limit rather than pretend.
2. **`debugger` infobar** is visible on every attached tab. Accepted: honest, non-blocking.
3. **MV3 keepalive** is the most likely source of flaky "agent went deaf" reports. Build the state machine first, test it first.
4. **Enterprise rollout**: force-install via `ExtensionSettings` policy works for managed Chrome; unmanaged machines still require a click, so "production-ready" for a nontechnical user depends on policy deployment.
5. **Trust surface**: `<all_urls>` + `debugger` means the extension can read any logged-in page. Same trade-off already accepted for Claude and Codex; must be stated in the privacy note.

## 11. Prior art (checked 2026-10-30 — do not re-invent this)

| Project | Licence / scale | Architecture | Relevance |
| --- | --- | --- | --- |
| **hangwin/mcp-chrome** ("Chrome MCP Server") | MIT, ~12.5k stars | Chrome extension + native-messaging bridge (`mcp-chrome-bridge`), exposes MCP over streamable HTTP on `127.0.0.1:12306`; 20+ tools incl. screenshots, network capture, semantic search over tab content | **Closest match to our design and proof it works.** Uses your daily Chrome, existing logins, fully local. Read `docs/ARCHITECTURE.md` before M0 |
| **Browser MCP** (browsermcp.io, `browsermcp/mcp`) | Open source | extension + local server, "let AI use your real browser" | Same thesis, simpler surface; useful for comparing tool vocabulary |
| **Nanobrowser** | Apache-2.0, ~14k stars | agent **inside** the extension (side panel), multi-agent loop, built on WXT + browser-use + Puppeteer | Opposite split from ours (agent in browser, not outside) — but the WXT build tooling and side-panel UX are worth borrowing |
| **browser-use** | MIT, ~119k stars | Python/TS agent library over CDP, element-indexed action space | Best action vocabulary to copy; connecting to *your* browser still needs the CDP port — the exact blocker this product removes |
| **Puppeteer / Playwright extension transports** | Apache-2.0 | drive *through* an extension rather than a port | Prior art for the message plumbing and for testing an extension-hosted backend |
| BrowserOS / Comet / Dia | mixed | own Chromium fork with the agent built in | Rejected: sessions move to a new browser |

**Decision: build ours, borrow freely.** None of them gives us Cua-shaped tools, the red/`Ava` marker contract, the `needs_human` taxonomy, or loopback-only WS with our token model — but `mcp-chrome` already solved the hard parts of "extension as hands". Concretely, before M0:

1. Read `mcp-chrome/docs/ARCHITECTURE.md` and its native-host registration + keepalive code, and record anything we should copy.
2. Evaluate **WXT** as the MV3 build tool (hot reload, manifest generation) instead of hand-rolled build config.
3. Keep **native messaging as the documented fallback** if the service-worker WebSocket proves too flaky in M0; `mcp-chrome` is the evidence that the native-host route works, at the cost of a registered host binary.
4. Compare our protocol (§5) against `mcp-chrome`'s tool list so we are not missing an obvious primitive.

## 12. Decisions taken (owner, 2026-10-30 — no longer open)

1. **Repo visibility:** private. Publish later if there is a reason.
2. **Cua integration:** a single alternate backend behind the existing `browser_*` tools, not a separate tool family. Nothing new for the agent side to learn.
3. **`page.evaluate`:** ships in v1 **behind a human-controlled options toggle, off by default** (§5.1). The agent can read the setting, never change it.
4. **Browser support:** Chrome first; Edge/Brave validated in M5 (same engine, expected to work unmodified).
5. **Distribution:** unpacked for development plus Chrome enterprise policy force-install for managed devices. No Web Store listing for now — the Store is a privacy write-up and a review cycle, and it is how we would later close the gap for *unmanaged* machines that still need a manual install.

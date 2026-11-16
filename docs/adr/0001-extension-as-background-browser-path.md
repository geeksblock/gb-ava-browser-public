# ADR 0001 — Use a browser extension as Ava's background browser path

- **Status:** Proposed (awaiting implementation; authorised by Elias 2026-10-29)
- **Date:** 2026-10-29
- **Deciders:** Elias Hernandez
- **Related:** IMPLEMENTATION-PLAN.md

## Context

Ava needs to operate web UIs that are already signed in as the owner: signed-in web admin consoles and portals. The requirement that makes this hard is **not** capability, it is discretion: the owner is working on the same Mac, and an agent that raises windows or grabs focus is unusable for slow tasks.

Current state, measured 2026-10-29 on a development Mac:

- **Remote-debugging port.** Cua's `browser_*` tools attach over CDP, but `browser_prepare` refused with: Chrome must come to the front for its "Allow remote debugging?" prompt whenever a new DevTools connection opens. Attaching therefore steals focus. It also only ever reaches the separate Chrome instance that was launched with the flag, whose profile is empty of the owner's sessions.
- **`chrome-devtools` MCP.** Works, but attached to a separate instance with its own profile — automatable, never the owner's logins.
- **Desktop accessibility / CGEvent.** Reads the window fine (`get_window_state` returned the AX tree and screenshot of the real Chrome), but is tied to the window being on-screen and able to be raised, and cannot touch the DOM precisely.
- **Playwright.** Drove a full Microsoft sign-in successfully, in its own clean profile — again not the owner's sessions.

So the gap is precise: **a path into the real profile that does not need the window.**

## Decision

Build a Chrome MV3 extension (Geeksblock Ava Browser Extension) that the local Cua host drives over a loopback WebSocket, using `chrome.tabs`, `chrome.scripting` and `chrome.debugger`. Controlled tabs are grouped red and labelled `Ava` so the human can see what is being touched.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep using the remote-debugging port | Blocking consent prompt that fronts Chrome; wrong profile unless Chrome is relaunched with the flag |
| Launch a dedicated Chrome with `--remote-debugging-port` and a copied profile | Simple, but two profiles drift; passwords/passkeys and tenant sessions do not follow cleanly; user has two browsers |
| Playwright-owned Chromium | Excellent tooling, zero access to the owner's sessions; sign-ins must be repeated or TAPs minted each time |
| Native messaging host | Cleanest security model (no port at all), but needs a host binary + per-browser manifest registered per OS — heavy for clients, and cannot be dialled from outside the browser |
| Desktop automation only (Cua AX/CGEvent) | Works today, but window-bound and cannot read DOM structure precisely; also competes with the user for focus |
| Extension + loopback bridge | **Chosen**: per-tab, silent, reuses real sessions, deployable by policy |

## Consequences

**Positive**

- Background operation becomes possible at all: no focus theft, no window raising.
- Real sessions are reused — no repeated sign-ins, no TAP per task.
- The tab marker is a genuine transparency feature: the human can always see which tab an agent is in.
- Deployable to managed devices by Chrome enterprise policy, which is a good fit for a managed-IT company.

**Negative / accepted costs**

- A second browser integration to maintain alongside Cua's desktop path.
- MV3 service-worker suspension must be engineered around (offscreen document + alarms + reconnect). This is the primary reliability risk.
- `debugger` attach shows Chrome's "…started debugging this browser" infobar, and fails if DevTools is already open on that tab.
- Background-tab screenshots may be stale; accessibility reads are the reliable primitive.
- Trust surface: `<all_urls>` + `debugger` can read any logged-in page. Accepted, and to be stated plainly to the owner and in the privacy note.

**Explicitly preserved**

- Nothing about Ava's model policy, credentials or approval rules changes. The extension is a transport, not an authority: it can act only when the bridge sends a command, and the bridge only sends what Ava asked for.

## Notes

- Claude for Chrome (v1.0.102) holds exactly this permission set — `debugger`, `tabGroups`, `tabs`, `scripting`, `offscreen`, `alarms`, `nativeMessaging` — and marks its tabs with `chrome.tabGroups.update(..., { color: "orange", title: "Claude" })`. The architecture is proven in production by two vendors; this ADR adopts it deliberately rather than inventing a variant.

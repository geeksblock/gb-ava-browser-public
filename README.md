# Geeksblock Ava Browser Extension

**Status: M5 complete — a 500-entry audit trail in `health`, a reproducible package build, and an
enterprise install runbook — on top of M4's adapter, M3 actions, M2 reads, M1 tabs and the M0
skeleton.** The milestone table is in `IMPLEMENTATION-PLAN.md` §9. The plan is in
[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md); the deciding records are
[docs/adr/0001](docs/adr/0001-extension-as-background-browser-path.md) (why an extension) and
[docs/adr/0003](docs/adr/0003-socket-ownership-and-keepalive.md) (where the socket lives).

A Chrome (MV3) extension plus a loopback bridge that lets Ava drive a **real, already-signed-in
browser profile in the background** — reading pages and acting on them without raising the window,
stealing focus, or asking the user to approve remote debugging.

## Why

Ava's previous browser path drove Chrome over the remote-debugging port, which forces Chrome to front
itself for the *"Allow remote debugging?"* prompt — an agent working in the background interrupting
the owner. It also only reached a Chrome instance launched with that flag, whose profile is empty of
the owner's sessions. An extension is the only mechanism that reaches a tab and its internals without
focus.

## What works today (M5)

```
 Ava / Cua ──▶ bridge (127.0.0.1 only) ──WS + token──▶ extension service worker
                    │  GET /health, POST /rpc               │  supervisor (reconnect/backoff)
                    └  gb-ava-bridge CLI                    └  offscreen + alarm keepalive
```

- Extension service worker that connects to the local bridge and stays connected across MV3
  suspension (offscreen tick + `chrome.alarms`, tested over a
  five-minute idle window).
- Mutual authentication with a per-install token that is **never sent** (ADR 0005): the bridge proves
  it holds the token before the extension does, so a program that grabbed the port while the bridge
  was down learns nothing and is never obeyed. `POST /rpc` (CLI, adapter, MCP) uses one-time proofs
  bound to each request body, and checks the bridge's signature on every answer.
- Bridge that binds `127.0.0.1` only, refuses any `Host` but its own (DNS rebinding) and any
  non-extension origin, and answers `GET /health` with its own state; the extension's detail (audit
  trail, dialogs) is only for authenticated callers.
- Guard rails: `page.*` never touches browser pages, extension pages (including Ava's own settings) or
  local files; `page.upload` attaches only from the upload folder, `~/Ava Uploads` by default.
- `tabs.list`, `tabs.query`, `tabs.navigate`, `tabs.group`, `tabs.ungroup`, `tabs.close`,
  `session.start` and `session.end` on the wire: explicit tab ids or predicates, navigation without
  focusing the tab, and the red `Ava` marker group that ungroups on session end, tab close, or one
  minute after the bridge goes away.
- `page.readAX`, `page.getText` and `page.screenshot` against a tab that is **not** in front: the
  accessibility tree with the backend node ids M3 will click, rendered text without the debugger, and
  a tab-only PNG whose staleness is reported rather than hidden.
- `page.click`, `page.type`, `page.key`, `page.scroll`, `page.select`, `page.upload`, `page.download`,
  `page.waitFor` and the human-gated `page.evaluate` — all on a tab that is not in front, with a modal
  dialog reported as `needs_human` instead of hanging.
- `@gb-ava/adapter` — the `browser_*` tool shape an agent calls, one protocol method per tool, mapping
  a human-blocked command to a typed `NeedsHumanError` (JavaScript dialogs and intercepted file
  choosers are detected; CAPTCHA only when visibly present; WebAuthn and permission prompts still
  surface as timeouts and the docs say so).
- A 500-entry audit ring in `health.audit`: method, tab, bounded arguments, outcome and duration — no
  page content, and typed text appears as a character count so a password never lands in it.
- `npm run package` producing `dist-package/gb-ava-extension-<version>.zip` with a printed SHA-256, and
  `packaging/` + `docs/runbooks/enterprise-install.md` for a force-install policy.
- `@gb-ava/mcp` — a stdio MCP server exposing the tools to an agent host (OpenCode and anything else
  that speaks MCP), with a `needs_human` answer delivered as an actionable tool error.
- `health` and `settings.get` on the wire. `page.evaluate` is **off** unless a human enables it in the
  options page (plan §5.1) — the agent may read the switch, never flip it, and gets
  `evaluate_disabled` with a hint until then.
- Options page for pairing, with the human-owned switches and live status.
- Unit tests (protocol, tabs, marker lifecycle, supervisor, backoff, redaction, bridge) and Playwright
  integration tests that drive the bridge, not the page, against a real Chromium with the extension
  loaded.

Not yet, and honestly so: detection for the WebAuthn and permission-prompt `needs_human` reasons; the
enterprise policy applied on a real managed device; and Edge/Brave verified in a release run (they load
the same package, but the automated suite runs Chromium).

## Using it from an agent host

The tool surface is served over MCP (`mcp/dist/index.js`), so a host only needs one config entry:

```jsonc
"gb-ava-browser": {
  "type": "local",
  "command": ["node", "<repo>/mcp/dist/index.js"],
  "enabled": true
}
```

It reads the bridge token from `~/.config/gb-ava-bridge/token` itself — no secret in the config file,
nothing listening. The human-owned `page.evaluate` switch stays inside the extension, so the MCP
cannot bypass it.

## Quickstart

```bash
npm install && npx playwright install chromium
npm run build
node bridge/dist/cli.js serve            # prints the port; token in ~/.config/gb-ava-bridge/token
node bridge/dist/cli.js token            # paste this into the extension options page
```

Then load `extension/dist` unpacked at `chrome://extensions` and open the extension options page.
Full instructions, including the test commands and troubleshooting: [docs/runbooks/local-development.md](docs/runbooks/local-development.md).

## Documentation

| Document | Contents |
| --- | --- |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | Milestones, protocol sketch, security posture, risks, prior art |
| [docs/protocol.md](docs/protocol.md) | The wire contract: envelope, handshake, close codes, methods, error taxonomy |
| [docs/architecture.md](docs/architecture.md) | Components, keepalive mechanics, command handling, security boundary |
| [docs/adr/](docs/adr/) | Decision records |
| [AGENTS.md](AGENTS.md) | Non-negotiables for whoever works in this repo |

## Permissions and trust surface

`tabs`, `tabGroups`, `scripting`, `debugger`, `storage`, `alarms`, `offscreen`, `downloads`, and
`<all_urls>`. Each is justified in plan §3; adding another needs an ADR. Stated plainly: `<all_urls>`
plus `debugger` means the extension **can read any page you are signed into**. It makes no other
network request — the loopback socket is the only egress. Controlled tabs will be grouped red and
labelled `Ava` from M1 so it is always visible what is being touched.

No cookies are read, no analytics, no remote config, and the bridge token never appears in a log.

## Prior art

This architecture is not novel: `hangwin/mcp-chrome` (MIT) ships extension-plus-local-server for the
same reason. We borrow its operational shape (loopback health surface, offscreen keepalive, native
messaging as the documented fallback) and keep our own contract: Cua-shaped tools, the red `Ava`
marker, the `needs_human` taxonomy, and loopback-only WebSocket with our token model. Details in
plan §11 and ADR 0002.

## License

Proprietary — © Geeksblock LLC. All rights reserved.

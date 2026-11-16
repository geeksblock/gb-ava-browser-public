# Runbook — local development of the Ava browser path

Audience: contributors. Everything here runs on one machine; nothing
leaves it except `npm install` / `npx playwright install`.

## 0. Prerequisites

- Node 22+ (built and tested on Node 24).
- Chrome (stable) for the manual load; Playwright's bundled Chromium for the automated tests.
- `npm install` at the repo root, then `npx playwright install chromium` once.

## 0a. Running it day to day

Run the bridge as a per-user login service (a macOS LaunchAgent, a systemd user unit, or similar)
so it survives a restart. The per-install token lives in `~/.config/gb-ava-bridge/token` (0600);
print it with `node bridge/dist/cli.js token` and paste it into the extension's options page, which
then shows only a fingerprint. Load the unpacked `extension/dist` from a stable path so the
extension id does not change between builds.

## 1. Build

```bash
npm run icons      # only when the mark/size/colour changes
npm run build      # -> extension/dist (unpacked) and bridge/dist/cli.js
npm run typecheck
npm test           # unit tests (protocol, supervisor, backoff, redaction, bridge)
```

`npm run build` is also run automatically by the Playwright global setup, so the artefact under test
is always the current source.

## 2. Start the bridge

```bash
node bridge/dist/cli.js serve          # or: npm run bridge
```

- Binds `127.0.0.1:8765` by default; `--port` or `AVA_BRIDGE_PORT` to change it. It never binds a
  wildcard address.
- On first run it creates `~/.config/gb-ava-bridge/token` (0600) and says so. Print the token with
  `node bridge/dist/cli.js token`. The token is printed **only** by that command; logs carry an
  8-character fingerprint instead.
- `AVA_BRIDGE_CONFIG_DIR` points the bridge at another config directory (used by the tests).
- Optional: `~/.config/gb-ava-bridge/config.json` `{ "allowedExtensionIds": ["<id>"] }` narrows which
  extension may connect. Empty list = any `chrome-extension://` origin, which still excludes web
  pages.

## 3. Load the extension and pair it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → `extension/dist`.
2. Open the extension's **Details → Extension options** (or click the toolbar button).
3. Paste the bridge address (default `ws://127.0.0.1:8765`) and the token from step 2 → **Save and
   connect**.
4. The badge should read `connected`, and the Status card should show the offscreen keepalive as
   `present` and the alarm as scheduled.

`page.evaluate` is **off** unless you tick it in the options page (Agent permissions). Ava can read
that switch (`settings.get`, `health`) but cannot change it.

## 4. Verify from the bridge (the acceptance path)

```bash
node bridge/dist/cli.js health          # exit 0 only when the extension is connected
node bridge/dist/cli.js call settings.get
curl -s http://127.0.0.1:8765/health | jq .extension
```

`/health` and `/version` need no credential so the `curl` above keeps working. `POST /rpc` does need
the per-install token; the CLI adds it for you, and a hand-written call must add it too:

```bash
curl -s http://127.0.0.1:8765/rpc \
  -H "authorization: Bearer $(node bridge/dist/cli.js token 2>/dev/null)" \
  -H "content-type: application/json" \
  -d '{"id":"manual-1","method":"settings.get"}' | jq .
```

A caller without it gets `401 unauthorized`; a browser page is refused with `403` outright, because
every HTTP route rejects an `Origin` that is not the extension's.

### Tabs and the marker

```bash
node bridge/dist/cli.js call tabs.list '{"limit":10}'
node bridge/dist/cli.js call tabs.navigate '{"tabId":123,"url":"https://example.com"}'
node bridge/dist/cli.js call session.start '{"tabIds":[123]}'   # the tab turns red, titled "Ava"
node bridge/dist/cli.js call session.end                        # ungrouped again
```

`tabs.list` answers with the tabs the extension can address; `tabs.navigate` moves one without
bringing the window forward. After `session.start`, look at the browser: one red group titled `Ava`.
`session.end`, closing the last tab in it, or killing the bridge for a minute takes it away again.

### Reading a background tab

```bash
node bridge/dist/cli.js call tabs.list '{"limit":5}'
node bridge/dist/cli.js call page.getText '{"tabId":123}'
node bridge/dist/cli.js call page.readAX '{"tabId":123,"limit":50}'
node bridge/dist/cli.js call page.screenshot '{"tabId":123,"detectStale":true}'
```

Put another tab in front first: none of these brings the tab forward. The first `page.readAX` on a tab
attaches the debugger, so Chrome shows its "started debugging this browser" infobar — expected, and it
goes away when the tab closes, navigates, or the worker is suspended. If a read answers with
`source: "scripting"`, DevTools is open on that tab; close it and read again for geometry and precise
roles.

The suite proves reads with the tab behind another tab, and — on macOS — with another application
frontmost (it activates Finder first). The occluded case is what the M2 acceptance asks for, so run it
on a Mac before calling a release good; the Linux CI run proves the tab-not-active half only.

### Packaging

```bash
npm run package     # builds, then writes dist-package/gb-ava-extension-<version>.zip
```

It prints the SHA-256 of the zip — put that in your password manager or the release ticket, not the zip itself.
Loading the unpacked `extension/dist` in `chrome://extensions` is the developer path; the enterprise
policy path is `docs/runbooks/enterprise-install.md`.

### The MCP server (what an agent host connects to)

```bash
node mcp/dist/index.js      # speaks JSON-RPC on stdin/stdout
```

Point it at a non-default bridge with `AVA_BRIDGE_PORT`, and at a non-default token with
`AVA_BRIDGE_CONFIG_DIR`. In OpenCode, the entry is a `local` MCP server whose command is the node
binary plus `mcp/dist/index.js`; nothing else is needed.

### The adapter (what an agent actually calls)

```bash
node -e '
import("./adapter/dist/index.js").then(async (adapter) => {
  const client = new adapter.BridgeClient();
  const context = { client };
  const tabs = await adapter.browser_tabs(context, { limit: 5 });
  console.log(JSON.stringify(tabs, null, 2));
});'
```

Point it at a non-default bridge with `AVA_BRIDGE_PORT`, and at a non-default token with
`AVA_BRIDGE_CONFIG_DIR`. A `NeedsHumanError` carries `reason`; a `BridgeError` carries the protocol
code. If a call answers `needs_human`, ask the owner — do not retry.

### Acting on a tab

```bash
node bridge/dist/cli.js call page.type '{"tabId":123,"selector":"#email","text":"ava@example.com","pressEnter":true}'
node bridge/dist/cli.js call page.waitFor '{"tabId":123,"selector":"#code","timeoutMs":8000}'
node bridge/dist/cli.js call page.click '{"tabId":123,"nodeId":101}'      # a nodeId from page.readAX
node bridge/dist/cli.js call page.select '{"tabId":123,"selector":"#colour","value":"green"}'
node bridge/dist/cli.js call page.upload '{"tabId":123,"selector":"#file","files":["/tmp/note.txt"]}'
```

If a command answers `needs_human` with `reason: "javascript_dialog"`, a dialog is open on that tab:
dismiss it (or answer it) in the browser and retry. `health` shows what is open under `dialogs`.

`npm run screenshot:options` writes `test-results/options-page.png` from a throwaway profile — the
quickest way to review the one human-facing surface without loading the extension into your own
Chrome.

`health` is the single operational question: bridge state, extension session, keepalive state, and
whether `page.evaluate` is enabled.

### The real acceptance check (manual, needs a tenant)

The M3 acceptance is a real Microsoft Entra sign-in with a Temporary Access Pass on a background tab.
The automated suite reproduces the same shape offline; before a release, run the real one with the
window behind another app:

1. Start the bridge, pair the extension, open the Entra sign-in page in a tab, then bring a different
   app to the front.
2. `page.type` the UPN, `page.key Enter`, `page.waitFor` the TAP field, `page.type` the pass,
   `page.key Enter`, `page.waitFor` a URL that indicates the signed-in state.
3. Confirm the tab never came forward and that no "Allow remote debugging?" prompt appeared.

## 5. Tests

```bash
npm test                                   # unit
npm run test:integration                   # Playwright: launches Chromium with the extension, drives the bridge
npm run test:keepalive                     # 5-minute soak; the M0 acceptance gate
AVA_KEEPALIVE_IDLE_SECONDS=60 npm run test:keepalive   # shorter soak while developing
```

The keepalive test writes `test-results/m0-keepalive-evidence.json` (session stability, worker start
count, tick counts) — attach it to the milestone review rather than describing the result from
memory.

## 6. Troubleshooting

| Symptom | Check |
| --- | --- |
| Options page badge `blocked` with `unauthorized` | Token mismatch. Re-print with `cli.js token`, paste again. The supervisor deliberately stops retrying so a wrong token cannot hammer the bridge. |
| Badge `backoff`, bridge log shows `rejected upgrade: wrong path` | The address must be `ws://127.0.0.1:<port>`; the extension appends `/extension` itself. |
| Bridge log shows `rejected disallowed origin` | Something other than the extension connected (a web page, a proxy). Check `allowedExtensionIds`. |
| Bridge log shows `rejected non-loopback upgrade` | The socket reached the machine from off-host — usually a port forward or a wrong bind. |
| `health` says connected but `offscreenDocument` is `false` | Chrome refused the offscreen document (see the worker log). The alarm still fires every 30 s, so a 5-minute soak will look fine while the 20 s cadence is missing. Read the worker console before concluding it works. |
| Extension disappears after a Chrome update | Reload the unpacked extension; check `chrome://extensions` for a permission error. |
| Nothing obvious in the logs | `node scripts/debug-connect.mjs` launches Chromium with the extension, pairs it, prints the supervisor phase every 2 s and then the bridge's stderr and `/health`. It is the fastest way to see whether the client or the bridge is refusing. |

## 7. What not to do

- Do not add a permission to `extension/manifest.json` without an ADR (AGENTS.md rule 1).
- Do not let anything call `chrome.tabs.update({active:true})` on the controlled tab — nothing may
  raise a window.
- Do not retry a `click`/`type` automatically.
- Do not log the token, or a value a caller marked `sensitive`.

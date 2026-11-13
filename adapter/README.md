# @gb-ava/adapter — Cua-shaped tools over the Ava bridge

This package is the surface an agent calls. It exposes the `browser_*` tool shape Cua uses and
translates each call into exactly one protocol method on the local bridge. It adds no policy beyond
three rules:

1. **Every call names its tab.** There is no "current tab".
2. **A failure that needs a human is a typed `NeedsHumanError`**, never a retry and never a silent
   dismissal. Today that means `javascript_dialog`, `file_picker` and `captcha`; `webauthn` and
   `permission_prompt` are in the enum but not yet detected, and an unrecognised reason arrives as
   `unknown` rather than being rewritten.
3. **Everything else is a `BridgeError`** carrying the protocol's own code and retryability, so a
   caller can branch without parsing prose.

## Tools

| Tool | Protocol method | Notes |
| --- | --- | --- |
| `browser_tabs` | `tabs.list` | bounded list; no page content |
| `browser_find_tab` | `tabs.query` | url substring / title substring / group / window |
| `browser_navigate` | `tabs.navigate` | never brings the tab forward |
| `browser_close_tab` | `tabs.close` | one explicit tab |
| `browser_activate_tab` | `tabs.activate` | selects the tab in its window; does **not** raise the window unless `focusWindow: true` |
| `browser_session_status` | `session.status` | driven tabs, which still exist, which vanished |
| `browser_session_start` / `browser_session_end` | `session.start` / `session.end` | the red `Ava` marker: do this **first**, with the tab ids — the tab-strip label only exists while a tab is in the group |
| `browser_read_page` | `page.getText` + `page.readAX` | text **and** tree in one answer |
| `browser_screenshot` | `page.screenshot` | tab only; staleness reported |
| `browser_click` | `page.click` | node id, selector, or coordinates; a selector resolves inside child frames too; `input.route` says whether real input or an in-page dispatch was used; raises `NeedsHumanError` when the click left a dialog or chooser waiting |
| `browser_type` | `page.type` | `clear`, `pressEnter` |
| `browser_key` | `page.key` | named keys and modifiers |
| `browser_scroll` | `page.scroll` | no target needed: the page's scroller moves; a node targets its own container; works on a background tab |
| `browser_select` | `page.select` | fires `input`/`change` |
| `browser_upload` | `page.upload` | absolute paths; hidden inputs work |
| `browser_download` | `page.download` | reports what Chrome saved |
| `browser_wait` | `page.waitFor` | selector / text / URL |
| `browser_evaluate` | `page.evaluate` | **refused unless a human enabled it** |

## Driving the same Chrome as another tool

Two tools can be pointed at one browser. The honest division, which the issues
that produced `tabs.activate` asked to have written down:

- **This extension owns background work.** It reads and drives a tab that is not
  active, in a window that is behind another application, without raising either.
- **A GUI driver (cua-driver, an accessibility-tree tool) only sees the active tab
  of a window.** Its non-attaching path reads the window's accessibility tree, and
  a background tab is not in it. Attaching a second debugger can also refuse in the
  background, because Chrome fronts itself to show its remote-debugging prompt.
- So when a task needs *both* — a GUI step on a page this extension is driving —
  call `browser_activate_tab` first and `focusWindow: true` if the other tool needs
  the window in front. Both facts are in the reply: `windowRaised` says whether the
  window came forward, so nothing raises the owner's browser silently.
- **Who wins a debugger session on one tab:** this extension attaches through
  `chrome.debugger` and reports `debugger_unavailable` when somebody else (usually
  the tab's DevTools) already owns it; a read then degrades to `source:
  "scripting"` and says so. It never retries in a loop and never steals the session.

## Usage

```ts
import { BridgeClient, browser_click, browser_read_page } from "@gb-ava/adapter";

const client = new BridgeClient();               // reads ~/.config/gb-ava-bridge/token (0600)
const context = { client };

const page = await browser_read_page(context, { tabId });
const button = page.tree.nodes.find((node) => node.role === "button" && node.name === "Sign in");
await browser_click(context, { tabId, nodeId: button.nodeId });
```

The token is read from the config directory rather than taken as an argument, so an adapter process is
never handed a secret on a command line. It is only ever sent to `127.0.0.1`.

## What a `needs_human` answer means

The browser is waiting for a person and the adapter will not guess. Ask the owner, do not retry:

- `javascript_dialog` — an alert/confirm/prompt is open on that tab; every command on that tab refuses
  until it is dismissed. `health.dialogs.open` names the tab.
- `file_picker` — a click opened a file chooser, which Ava intercepted instead of raising Chrome's
  picker; answer it with `browser_upload` on that input, or let a human pick.
- `captcha` — a stalled command on a page that visibly shows a CAPTCHA. This probe runs through
  `page.evaluate`, so it only works when the owner has enabled that switch; otherwise a stall stays a
  plain `timeout`.

**Not yet detected, and honest about it:** WebAuthn/Touch ID sheets and browser permission prompts do
not block the renderer, so the action that triggered one returns normally and a later `browser_wait` or
`browser_navigate` is what eventually times out. Naming them is the remaining M4 gap (see
`docs/protocol.md`).

# AGENTS.md — working rules for this repo

Read, in order, before writing code: `IMPLEMENTATION-PLAN.md`, then `docs/adr/0001-extension-as-background-browser-path.md`.

## What this is

The **Geeksblock Ava Browser Extension** — an MV3 Chrome extension plus a local bridge that lets Ava drive a real, signed-in Chrome profile in the background. Product owner: Elias Hernandez. Manufacturer for branding: Geeksblock LLC.

## Non-negotiables

1. **No new permissions without an ADR.** The permission list in the plan is the result of a decision, not a draft. Adding `cookies`, `webRequest` or `identity` needs justification in `docs/adr/`.
2. **Nothing raises the window.** If an implementation needs to front Chrome to work, it is wrong for this product. Exception: a system sheet that genuinely needs a human (`needs_human`), which must be reported, never auto-dismissed.
3. **Never depend on the tab group for logic.** Red/`Ava` is a marker for the human. Control state must live in code.
4. **Fail closed.** Unknown method, unknown tab, ambiguous target → explicit error. No silent no-ops, no invented defaults.
5. **No silent retries.** `click` and `type` are not idempotent. If a command's outcome is unknown, report it; do not replay it.
6. **Secrets never leave the machine** and are never logged: the bridge token, and anything a caller marks `sensitive`.
7. **The agent never changes its own settings.** `page.evaluate` ships behind an options toggle (plan §5.1), off by default, flipped by the human in the extension UI. Ava may read it via `settings.get`/`health`; if it needs it on, it asks. When disabled, return `evaluate_disabled` with a readable hint — never silently fall back to something else.
8. **The token never crosses the wire (ADR 0005).** Both channels use the mutual HMAC proof, with the bridge proving itself first; neither side acts on a request before the handshake completes. Never reintroduce a bearer header, a token in `hello`, or a request path that runs before `hello_ok` — `tests/unit/bridge.test.ts` and `tests/unit/security-hardening.test.ts` fail if you do. Likewise keep the `Host` check, the narrow `/health`, the upload-folder confinement, the protected-tab guard and the options-page sender check.

## Conventions

- TypeScript strict; Chrome MV3; no UI framework. `extension/` and `bridge/` as separate packages.
- Tests: `vitest` for units; Playwright for integration, launching Chromium with `--load-extension` and driving the **bridge**, not the page.
- Conventional commits, one milestone per branch, PR into `main`. No direct pushes to `main` once CI exists.
- Documentation ships with the code: protocol changes update §5 of the plan; new failure modes update §7.
- Icons: one locally bundled Phosphor icon family, rendered to PNG for the manifest sizes. No hand-drawn SVG paths, no emoji.
- The tab group label is exactly `Ava`, colour exactly `red`. Do not "improve" it.

## Build order

Follow the milestones in §9 of the plan. M0 (skeleton + keepalive) and M2 (background reads) are the riskiest; do not start M3 until M2's acceptance test passes with Chrome occluded.

## Definition of done for M4

The acceptance test in §1 of the plan, run with Chrome behind a full-screen app, passing without any change of frontmost window or pointer position.

## Out of scope

Desktop automation (Cua handles that), Firefox/Safari, page-injected UI, telemetry.

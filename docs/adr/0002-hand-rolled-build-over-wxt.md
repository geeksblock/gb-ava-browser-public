# ADR 0002 — Keep the hand-rolled esbuild build instead of adopting WXT

- **Status:** Accepted (owner asked for the comparison, 2026-10-30)
- **Date:** 2026-10-30
- **Deciders:** Elias Hernandez (product owner), implementation by Ava
- **Related:** `IMPLEMENTATION-PLAN.md` §11.2, §11.4; `scripts/build.mjs`

## Context

The plan (§11.2) asked for a time-boxed evaluation of **WXT** as the MV3 build tool instead of the
hand-written `scripts/build.mjs` that was scaffolded for M0. The trigger was prior art:
`hangwin/mcp-chrome` (MIT) ships this same architecture on WXT + Vue.

What this product actually needs from a build:

1. three entry points: an MV3 service worker, an offscreen document, one options page;
2. TypeScript strict, no UI framework (AGENTS.md conventions);
3. an **exact** `manifest.json` that a reviewer can read against plan §3, because "no new permission
   without an ADR" is a repo rule and a generated manifest makes that review indirect;
4. an unpacked build directory that Playwright can pass to `--load-extension` with zero extra
   tooling, plus a bundleable Node CLI for the bridge;
5. Chrome only in v1 (Edge/Brave validation is M5).

Evaluated on 2026-10-30: WXT `0.21.5`, Vite-based, entrypoint discovery under `entrypoints/`,
manifest assembled from entrypoint metadata and `wxt.config`, `wxt dev` launching its own browser
profile with HMR for UIs, `wxt zip` for packaging, multi-browser targets.

## Decision

**Keep the hand-rolled build.** It is ~110 lines of esbuild that does exactly the five things above.

## Why — the specific differences that mattered

| Question | WXT | Hand-rolled esbuild |
| --- | --- | --- |
| Manifest review for permission control | Generated from entrypoint `<meta>` and config; permissions live in a config object and entrypoint options | `extension/manifest.json` is the literal file Chrome loads — diffable against plan §3 |
| Runtime code shape | Background entrypoint must be `defineBackground({ main() })`; module-scope runtime code is not allowed because the file is also imported by Node during build | Normal modules; the state machine and settings code stay directly unit-testable, `void bootstrap()` is fine |
| Offscreen document | Unlisted HTML entrypoint + manually added `offscreen` permission | Explicit `offscreen.html` + permission in the manifest |
| Dependency surface | 24 runtime deps + `vite` peer (rollup/vite toolchain) | `esbuild`, `typescript`, `vitest`, `@playwright/test`, `ws` |
| Dev loop | HMR for UI, auto browser launch with its own profile | Rebuild + press reload; UI is one static page in v1 |
| Packaging for M5 | `wxt zip` | `chrome --pack-extension` / a 10-line zip; not needed yet |
| Test path | `.output/chrome-mv3` (fine) but `wxt dev`'s browser/profile is not the Playwright path | `extension/dist` is the tested artefact and the loaded artefact — same thing |
| Multi-browser | Real strength (Chrome/Edge/Firefox matrix) | Out of scope until M5, one target |

None of WXT's strengths are on the v1 critical path; two of our hard rules (a literal manifest for
permission governance, and pure-testable modules) are friction under it. Adopting a framework to
save the ~110 lines of build script would trade a reviewable control for convenience we do not yet
need.

## Consequences

- We own the build script. It must stay small; anything beyond bundling three entries + copying
  static files belongs in a test or a script, not in the build.
- Packaging for enterprise policy (M5) is our job — `npm run package` will produce a `.crx`/zip.
- No HMR: after `npm run build`, the options page needs a reload. Acceptable for one static page.

## Revisit trigger (explicit, so this is not relitigated ad hoc)

Adopt WXT when **either** is true:

1. we need real multi-browser builds (Edge/Brave/Firefox) as a maintained matrix, or
2. the extension grows a UI that benefits from HMR (a side panel or a status dashboard), or
3. our build script passes ~200 lines because we keep re-implementing what WXT already does.

## What was borrowed from the prior art instead

From `hangwin/mcp-chrome`, without adopting its stack:

- the extension-plus-local-server shape, with the local server exposing **HTTP health on loopback**
  as the operational question "is the browser path alive?" (theirs: MCP on `127.0.0.1:12306`);
- the offscreen-document keepalive pattern for MV3;
- **native messaging as the documented fallback** if the service-worker WebSocket proves flaky in
  M0 (their transport). Recorded in ADR 0003 and in the M0 issue rather than implemented twice.

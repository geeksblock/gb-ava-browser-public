# ADR 0004 — the HTTP tool surface is authenticated with the per-install token

Status: **accepted** (M0), supersedes the "M4 adds the operator token" line in `IMPLEMENTATION-PLAN.md` §5.

## Context

`POST /rpc` is how a local tool drives the browser: the `gb-ava-bridge` CLI today, the Cua adapter
in M4. M0 shipped it open to any loopback caller on the reasoning that its only methods were reads
(`health`, `settings.get`), with the operator token deferred to M4.

That reasoning expires earlier than the plan assumed. M1 adds `tabs.navigate` and `tabs.close`;
M2/M3 add page reads, clicks and typing. A browser page the user has open is a *local* client of
`127.0.0.1:8765` — it can send a `text/plain` POST with no preflight — so from M1 the browser can
make the agent close a tab. It cannot read the reply (no CORS header), which makes the effect
silent, exactly the class of surprise the plan's fail-closed rules exist to prevent.

## Decision

1. `/rpc` requires the per-install token, presented as `Authorization: Bearer <token>` or the
   `x-ava-token` header, compared in constant time. No token, or a wrong one: `401 unauthorized`,
   nothing forwarded. The CLI reads the same `~/.config/gb-ava-bridge/token` (0600, re-asserted on
   load), so operator ergonomics do not change.
2. Every HTTP route refuses a request whose `Origin` is present and not the extension's — the same
   policy the socket upgrade applies. A browser always sends `Origin`; the CLI and `curl` send none.
3. `GET /health` and `GET /version` stay tokenless. They report state, change nothing, and a human
   diagnosing with `curl` should not need a secret. They are still origin-refused.

## Consequences

- Two credentials now exist for two channels, but it is **one secret**: the same per-install token
  guards the extension socket and the tool surface. Nothing new to rotate or store.
- The M4 Cua adapter authenticates by reading the config file rather than by a new handshake.
- A caller that forgets the header gets a clear 401 instead of a mysterious timeout.
- `/health` remains safe to expose to any local process; it can reveal the extension id and
  version, which is acceptable and is why the token is not printed there.

## Alternatives rejected

- **Wait for M4** (the original plan): leaves M1–M3 writes on an unauthenticated loopback channel.
- **A second, separate operator token**: two secrets to provision, rotate and explain, for one
  local trust boundary.
- **Require the token on `/health` too**: breaks the `curl` diagnostic and the runbook's first
  troubleshooting step, for no security gain beyond hiding the extension version.

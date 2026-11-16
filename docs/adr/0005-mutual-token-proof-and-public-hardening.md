# ADR 0005 — mutual token proof, and the hardening the public security review asked for

Status: **accepted** (2026-11-15). Amends ADR 0004: the per-install token still guards both channels,
but it is never sent; each side proves it holds it. Protocol version 2.

## Context

The repository became public, and a security review of the bridge and extension (each finding
checked by three independent reviewers trying to refute it; none was refuted) found six issues. None
was introduced by publishing, but a public codebase makes them cheaper to find.

1. **Port squatting (medium).** The extension dials `ws://127.0.0.1:8765` and sent the raw token in
   its first frame to whatever answered. While the bridge was down, any local process — including
   another macOS account, since loopback ports above 1024 are shared across users — could bind the
   port, collect the token, and drive the signed-in browser. Worse, the extension acted on request
   frames before the handshake finished, so a squatter did not even need the token. The adapter and
   CLI likewise sent `Authorization: Bearer <token>` to whatever listened.
2. **Tokenless `/health` leaked browsing detail (medium/low).** It forwarded the extension's health:
   the last audit entries (URLs, selectors), open dialog text. No `Host` check existed, so a page using
   DNS rebinding (its own name resolving to 127.0.0.1, same-origin GET, no `Origin` header) could read it.
3. **`page.upload` accepted any absolute path, and `file:` URLs were navigable (medium).** An agent
   steered by a malicious page, or a squatter, could attach `~/.ssh/id_rsa` or the bridge token file to
   an attacker's form, or open and read local files.
4. **The agent could flip its own settings (medium).** Nothing stopped `page.click` on the extension's
   own options page if the human left it open, breaking AGENTS.md rule 7 (`page.evaluate` is
   human-only).
5. **Unauthenticated sockets could rewrite `/health`'s error (low).** With no extension-id allowlist,
   any extension could open sockets that never authenticate and overwrite `lastDisconnectError`.
6. **Pre-auth resource use (low).** Unauthenticated sockets got the full 12 MB frame limit, with no cap
   on how many could be mid-handshake; `page.select`'s `value` was unbounded.

## Decision

### Mutual proof, the token never crosses the wire (findings 1, 5)

Socket, four frames (protocol v2):

```
client → hello            { protocolVersion: 2, clientNonce, client }      no token, no proof
server → hello_challenge  { serverNonce, serverProof }                     the bridge proves first
client → hello_auth       { clientProof }                                  only after verifying
server → hello_ok         { sessionId }
```

`proof = HMAC-SHA256(token, label + "\n" + clientNonce + "\n" + serverNonce)`, base64url, with a label
per direction (`gb-ava/v2/ws-server`, `gb-ava/v2/ws-client`) so a proof made for one purpose cannot be
replayed for another. Nonces are 32 random bytes. One WebCrypto implementation
(`shared/src/handshake.ts`) runs in both the service worker and the bridge.

- The extension **acts on nothing** from the peer until `hello_ok` follows a verified challenge. A
  `hello_ok` without a verified challenge, or a refusal from an unproven peer, is treated as an
  impostor.
- An unverified bridge **blocks** the supervisor (`blockedReason: bridge_unverified`), exactly like the
  old wrong-token case: a wrong pasted token and an impostor look identical from the extension, both
  need a human, and retrying into a possible impostor is the wrong default. The options page says so in
  plain words and Reconnect retries.
- On the bridge, refusals before the peer proved the token are recorded as
  `bridge.lastRejectedHandshake` and never overwrite the authenticated session's `lastDisconnectError`.

`/rpc` (CLI, adapter, MCP) gets the same property without a socket:

1. `POST /auth/challenge { clientNonce }` → `{ serverNonce, serverProof }` (label `gb-ava/v2/rpc-server`).
   The caller verifies it and **stops** if it fails.
2. `POST /rpc` with `x-ava-nonce: serverNonce` and `x-ava-proof: HMAC(token, rpc-client, serverNonce,
   sha256(body))`. Nonces are single use (spent even when the proof is wrong) and live 30 s; when 1,024
   are outstanding the oldest is dropped rather than a new caller refused.
3. A 200 answer carries `x-ava-response-proof: HMAC(token, rpc-response, serverNonce, sha256(answer))`;
   the caller refuses any 200, or any body claiming `ok: true`, without it. Unsigned errors (401, 413)
   are only ever reported as failures. Callers dial `127.0.0.1` only — never `localhost`, which may
   resolve to `::1`, where the bridge does not listen and another account could relay.

The raw-token `Authorization: Bearer` and `x-ava-token` headers are **no longer accepted**.

### Host check and a narrower `/health` (finding 2)

Every HTTP request and socket upgrade must carry `Host: 127.0.0.1:<port>`, `localhost:<port>` or
`[::1]:<port>`. `GET /health` returns bridge state and whether the extension is connected; the
extension's own health (audit, dialogs) is served only to an authenticated caller, as `/rpc` method
`health`. `gb-ava-bridge health` fetches both.

### Uploads from one folder, no `file:` (finding 3)

`page.upload` attaches only files inside the **upload folder**, `~/Ava Uploads` by default (created
private on first run; `uploadDirectory` in `config.json` changes it). The folder must be owned by the
user and not group- or world-writable, and may not be `/`, the home folder, or one containing the
bridge config (the token). Missing, outside and non-file paths all get the same error, so the call
cannot probe what exists elsewhere. The bridge — the only side that
can see the filesystem — resolves symlinks and `..` with `realpath`, refuses anything outside, and
forwards the real paths. `file:` is removed from the navigable schemes.

### Protected tabs and settings senders (finding 4)

Every `page.*` method refuses a tab whose URL is a browser page (`chrome:`, `devtools:`, …), any
extension page (`chrome-extension:`), or a local file (`file:`), before the debugger is touched.
Settings messages are accepted only from the extension's own options page; the keepalive only from its
offscreen document.

### Pre-auth limits (finding 6)

Before authentication a frame larger than 4 KB closes the socket, and at most 8 sockets may be
mid-handshake: a ninth evicts the oldest instead of being refused, so idle sockets cannot lock the real
extension out. `/auth/challenge` likewise drops its oldest nonce when 1,024 are outstanding. `page.select`'s `value` is capped at 500 characters.

## Alternatives considered

| Route | Gains | Costs | Verdict |
| --- | --- | --- | --- |
| **Mutual HMAC proof (chosen)** | Token never on the wire; impostor learns nothing and can't act; same secret, nothing new to provision or rotate; works in a service worker | Protocol bump (extension and bridge must update together); one extra round trip per `/rpc` call (loopback, sub-millisecond) | Chosen |
| Unix domain socket in a 0700 directory | Filesystem permissions authenticate the server; no crypto | A Chrome extension cannot open a Unix socket, so it fixes only the CLI/adapter half | Rejected as the main fix; possible later for the CLI |
| Native messaging (no port at all) | Strongest model: Chrome launches the host, nothing to squat | Per-browser, per-OS host registration and a binary; ADR 0001 rejected it for install friction on client machines | Rejected for now; still the documented fallback |
| LaunchAgent with KeepAlive | Shrinks the window in which the port is free | Does not close it; a crash or update still leaves a gap | Complementary, not a fix |
| Pin the extension id on first use | Stops other extensions opening sockets | A reinstall changes the id and would need an engineer to un-pin — breaks non-technical onboarding | Rejected; the token proof is the barrier, and pre-auth refusals can no longer pollute health |

## Consequences

- **Breaking:** update the extension and the bridge together. A v1 extension meeting a v2 bridge gets
  `protocol_mismatch`; a v2 extension meeting a v1 bridge cannot verify it (the old bridge has no
  challenge) and blocks as `bridge_unverified`, with the plain-language hint on its options page.
  Scripts that called `/rpc` with `curl -H "authorization: Bearer …"` must use `gb-ava-bridge call`.
- **Uploads:** files must be placed in the upload folder first. The error names the folder.
- **Not fixed here:** a process running as the *same* user can still read the 0600 token file; that is
  outside this product's trust boundary (it can also read the browser profile). Older public commits of
  the published copy are unaffected by this ADR.
- Tests: `tests/unit/bridge.test.ts` (handshake, `/rpc` proofs and replay, Host, `/health`, uploads,
  pre-auth limits) and `tests/unit/security-hardening.test.ts` (impostor bridge, pre-handshake requests,
  protected tabs, settings senders, adapter/shared proof parity). Each protection was mutation-checked:
  removing it fails a test.

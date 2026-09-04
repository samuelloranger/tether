# Tether security rework — Noise pairing & keypair auth (foundation)

**Status:** design / locked for spec review
**Date:** 2026-09-03
**Scope:** the *foundation* sub-project of the larger "make Tether safe to expose" rework. Later sub-projects (rendezvous relay, at-rest encryption) are out of scope here and noted under [Decomposition](#decomposition).

## Problem

Tether's current trust model is a single shared password sent as `Authorization: Bearer <password>` on every HTTP request and the WebSocket upgrade, argon2-verified server-side, over a self-signed-TLS-with-TOFU channel that also keeps a plaintext `:8085` listener open by default. Documented advice is "run it behind a tunnel." Concretely this leaves six holes:

1. The password **is** the token — a replayable long-term secret travels on every call.
2. Plaintext `:8085` is open by default; the password crosses the wire in cleartext until an operator manually flips `TETHER_TLS=only`.
3. Self-signed cert + TOFU → first contact is spoofable (MITM).
4. `CORS: *` — any web page the operator visits can reach a LAN/localhost Tether.
5. No rate-limit / brute-force protection on the password.
6. One shared secret → no per-device revocation, no rotation.

## Goals

Locked with the operator during brainstorming:

- **Internet-exposable.** Survive a public port against scanners and active attackers.
- **E2E transport.** Client↔server traffic confidential + tamper-proof and MITM-proof on first contact, *independent of the TLS PKI*.
- **Zero-knowledge relay.** Push relay (and any future rendezvous relay) never sees plaintext — already true for push; keep it true.
- **Per-device keypair auth.** Enrollment issues each device its own keypair; no replayable secret on the wire; per-device revocation.
- **Kill the shared password** as a credential entirely.

## Non-goals

- **Hiding the live PTY from a compromised server.** The server runs the shell; it inherently sees PTY bytes. Accepted and documented. E2E protects the wire, the relay, and pairing — not the host against itself.
- **At-rest encryption of the SQLite log.** Explicitly deferred (operator chose "accept server-trust limit"). Not in this spec.
- **Multi-user identity / RBAC.** One operator, many devices. Not accounts.

## Trust model (the reframe)

The new root of trust is **shell access to the host**. Whoever can run `tether pair` on the machine can enroll a device. This is the SSH `authorized_keys` model applied to shells:

- No shared secret exists to leak, phish, or brute-force.
- The server keeps a registry of **authorized device public keys** (analogous to `~/.ssh/authorized_keys`).
- A device authenticates by proving possession of its private key during a Noise handshake — never by sending a reusable secret.

This is the headline security property and the answer to "is this safe to expose": *auth is authorized_keys, transport is the WireGuard handshake.*

## Architecture

### One crypto core (`snow` via FFI)

Clients already share a Rust core (`crates/tether-core`) exposed to Swift via `crates/tether-ffi` (UniFFI) and to the Tauri desktop directly. The Bun server links Rust through Bun FFI.

Decision: implement the Noise handshake **once**, in Rust, using the audited [`snow`](https://docs.rs/snow) crate, in `tether-core`. Expose it to:

- **iOS** — through the existing `tether-ffi` XCFramework.
- **Desktop** — `tether-core` linked directly in `src-tauri`.
- **Server** — via Bun FFI over a small C ABI surface (new `crates/tether-ffi` export or a dedicated `tether-noise-ffi`), so the Bun/Hono server runs the *same* handshake bytes as the clients.

No hand-rolled cryptography in TypeScript. One implementation to audit. This is a hard requirement, not a convenience — hand-rolled TS crypto would be a worse Reddit story than the current design.

### Noise patterns

- **Pairing:** `Noise_XXpsk2_25519_ChaChaPoly_BLAKE2s` (or `_SHA256`; finalize in plan). The 8-char enrollment code is mixed in as the PSK. `XX` because neither side knows the other's static key yet; `psk2` binds the handshake to the one-time code so a MITM without the code cannot complete it. During the handshake the device learns and pins the server's static public key.
- **Reconnect (steady state):** `Noise_IK_25519_ChaChaPoly_BLAKE2s`. The device already knows (pinned) the server's static key and presents its own authorized static key. No code, no PSK, no MITM window. This is every connection after the first.

### Transport layering

Noise frames ride **inside** the existing WebSocket/TCP transport. TLS becomes optional defence-in-depth, no longer the trust anchor:

- Confidentiality + integrity + peer auth come from Noise, keyed by pairing.
- The existing self-signed TLS listener may remain for defence-in-depth and for tooling that expects `https://`, but pinning/TOFU is no longer load-bearing.
- Because Noise-encrypted frames are opaque, they can traverse a dumb relay unchanged — the relay/rendezvous story and the E2E story are the *same* mechanism (relevant to a later sub-project; foundation only needs to not preclude it).

## Pairing flow

```
host:   tether pair
        → generate one-time enrollment code (12 chars) + open enrollment window
        → print code (grouped XXXX-XXXX-XXXX) + QR carrying {address(es), code}
        → window: single-use, ~5 min expiry, rate-limited

device: enter 8-char code + address  (desktop, typed)   OR   scan QR (phone)
        → device generates its own X25519 static keypair
        → Noise XXpsk2 handshake, code = PSK
            · MITM without the code fails here
            · device learns + pins server static pubkey
            · device sends its static pubkey + a self-chosen label
        → server authorizes the device pubkey, records it in the device registry
        → enrollment window closes on first success

after:  device stores its private key in Keychain (iOS) / OS keyring (desktop)
        password never stored, never sent
        subsequent connects use Noise IK against the pinned server key
```

### The enrollment code (12 chars)

- **Alphabet:** Crockford base32 (no ambiguous `0/O`, `1/I/L`) → ~60 bits over 12 chars.
- **Display:** grouped `XXXX-XXXX-XXXX`, case-insensitive on entry.
- **Lifetime:** single successful use; ~5-minute expiry; rate-limited attempts (see Hardening).
- **Why 12, not 8:** an 8-char (~40-bit) code is safe against *online* guessing, but a passive MITM who records the pairing handshake can brute the PSK **offline** (~10¹², GPU-feasible) and enroll a rogue device. 12 chars (~60 bits, ~10¹⁸) puts offline brute out of reach while staying typeable in three groups of four. This closes the offline-brute corner flagged in review.
- **Delivery:** printed to the host terminal; QR encodes `{address(es), code}` for camera devices. Both paths are identical in security — QR only saves typing.
- **Optional SAS (high-value hosts):** after the handshake, host terminal and device may display a short word-pair derived from the handshake hash for the user to compare. Belt-and-suspenders; not required, since the code already authenticates the handshake.

Desktop has no camera, so the typed 12-char code is the **primary** path, not a fallback. It is the reason the code (not a pubkey-in-QR) is the out-of-band authenticator.

### Session rekey (forward secrecy)

Noise already gives per-session forward secrecy through the ephemeral keys in each handshake. For long-lived terminal sessions, add a **periodic rekey** of the transport keys (e.g. on a time or bytes-transferred threshold) so that a key compromised late in a session cannot decrypt the whole earlier scrollback. Rekey is a standard Noise transport operation (`Rekey()` on the cipher state); it is invisible to the PTY path and must never interrupt the byte stream. Resolve the exact trigger (time vs. bytes vs. both) during planning.

## Device registry & revocation

Server-side table of authorized devices, distinct from the existing **push**-device registry (`pushDevices.ts`, push tokens) — this one holds auth pubkeys. A device may later link the two, but auth and push are separate lifecycles.

Each row: id, self-chosen label, static pubkey, short fingerprint, paired-at, last-seen, last-known address.

### CLI (new verbs on the existing `main.ts` argv dispatch)

```
tether pair                             # open enrollment window → code + QR
tether devices                          # list authorized devices
tether device revoke <name|fp-prefix>   # revoke by label or fingerprint prefix
tether device rename <target> <name>    # optional, nice-to-have
```

`tether devices` output:

```
NAME              FINGERPRINT   PAIRED        LAST SEEN     ADDRESS
sam-iphone        7q4k92        2026-09-01    2m ago        100.x.x.x
desktop-homelab   b3f8a1        2026-09-03    now           127.0.0.1
```

### Revocation semantics (critical)

- Revoke **immediately tears down that device's live WS/sessions**, not just future connects. A revoke that leaves the current shell alive is not a revoke.
- Revoking the last remaining device **warns** but does not hard-block: shell access to the host + `tether pair` is always the recovery path, so lockout is recoverable by definition.
- The app UI mirrors the CLI (list + swipe-to-revoke) against the same server endpoints.

## Migration (password → keypair)

Mirror the existing TLS cutover precedent (`TETHER_TLS: both → only`, a deliberate host-side flip that leaves no client stranded):

- **Phase 1 — coexist.** Keypair auth ships alongside legacy password auth. Existing password-storing clients keep working. Each device migrates by running `tether pair` once and re-enrolling as a keypair device.
- **Phase 2 — flip.** A host-side switch (env flag, e.g. `TETHER_LEGACY_PASSWORD=off`, matching the `TETHER_TLS` shape) disables password auth. End state: password auth code path removed, `set-password` gone, no shared secret anywhere.

Fresh installs skip Phase 1: first-run is `tether pair`, not `tether set-password`.

## Hardening (rides along)

With the password gone and one narrow enrollment surface, tighten the rest so the port is genuinely exposable:

- **Drop the plaintext default.** New installs default to no plaintext listener; `TETHER_TLS=off` becomes an explicit opt-out, not the silent default. (Noise makes plaintext-transport confidential anyway, but a cleartext port is still a needless attack surface and a bad look.)
- **Lock CORS.** Replace `CORS: *`. Native clients don't need permissive CORS; scope it to nothing (or an explicit allowlist) so a random web page can't reach a local Tether.
- **Rate-limit the enrollment surface.** The only guessable input in the system is the 8-char code. Per-source and global attempt limits + the single-use/expiry window make brute force infeasible.
- **Security headers** on any HTTP surface that remains.

## Affected components (blast radius)

- **`crates/tether-core`** — new Noise module (`snow`), pairing + reconnect state machines, keypair generation, server-key pinning.
- **`crates/tether-ffi`** (or a new `tether-noise-ffi`) — C ABI surface for the Bun server to drive the same handshake.
- **`apps/server/src/server/`** — `auth.ts` (replace bearer-password middleware with Noise-authed device identity), `db.ts` (device registry migration), `main.ts` (new `pair` / `devices` / `device` verbs), the WS gateway in `app.ts` (wrap frames in Noise), `x509.ts`/`tlsStore.ts`/`tlsConfig.ts` (demote TLS to defence-in-depth), CORS config.
- **iOS (`clients/apple`)** — replace stored-password model (`HostStoreAdapter.password`, `NativeHostClient(profile, password)`, ~20 call sites) with keypair storage in Keychain + Noise client; pairing UI (scan/enter code); device management UI.
- **Desktop (`apps/desktop`)** — same credential swap in `src-tauri` (keyring) + Noise client; typed-code pairing UI; device management UI.
- **`apps/relay`** — unaffected (already zero-knowledge); confirm it stays so.
- **Deep-link scheme (`crates/tether-core/src/deep_link.rs`)** — extend `tether://` with a `pair` verb carrying `{address, code}`; reuse the existing parser rather than inventing a scheme.
- **Docs** — rewrite `docs/security.md`, `docs/privacy.md` transport sections around the new model.

## Testing strategy

- **Rust core:** handshake unit tests (XXpsk2 success; wrong-code failure; IK reconnect against pinned key; tampered-frame rejection); code encode/decode round-trip; property tests on the code alphabet.
- **Server (bun:test):** enrollment window lifecycle (single-use, expiry, rate-limit); device registry CRUD; revoke-tears-down-live-connection; migration coexist/flip; CORS rejection.
- **Cross-stack:** one integration test that pairs a simulated device end-to-end (Rust client handshake ↔ Bun server FFI) and exchanges a frame.
- **MITM negative test:** a relay/proxy that forwards handshake bytes without the code must fail to establish.

## Security target & decomposition

Honest scoring (a shell host is inherently trusted, so 10/10 does not exist; ~9 is the realistic ceiling for tether's own code):

- **Foundation as specced (this doc):** ~8.5/10.
- **+ signed updates + the cheap hardening (rekey, longer code — already folded in here):** ~8.8/10.
- **+ externally audited:** ~9/10.

**No-open-port exposure is a deployment concern, not a tether feature.** A rendezvous relay was considered and **cut**: it would require publicly-hosted, bandwidth-heavy infrastructure (forwarding continuous terminal I/O, unlike the tiny push blobs), which is not a burden this project will take on. Instead, the no-inbound-port path is delivered by **documenting existing tunnels** — Tailscale / WireGuard / Cloudflare Tunnel — which are professionally-hosted zero-knowledge rendezvous relays users already run, free, hosting nothing on our side. The foundation's Noise E2E rides safely over any of them.

This spec is the **foundation** sub-project. Downstream, each with its own spec → plan cycle:

1. **Signed, verified updates** — `tether update` verifies a minisign/cosign signature over the binary against a public key baked into the client. Closes the supply-chain path that bypasses all auth work. Own spec.
2. **External protocol/crypto audit + handshake/frame fuzzing** — the gate before any "internet-safe" / "audited" claim is made publicly. Not a code sub-project so much as a release gate.
3. **No-port exposure docs** — a "reach your server from anywhere" page that walks through Tailscale / Cloudflare Tunnel. Documentation, not code.
4. **At-rest encryption** — deferred by operator decision; revisit only if the threat model changes.

## Open questions (resolve during planning)

- Exact Noise cipher suite tail (BLAKE2s vs SHA256; ChaChaPoly is settled).
- Whether the Bun-server FFI reuses `tether-ffi` or gets a dedicated `tether-noise-ffi` crate (keeps UniFFI/Swift surface separate from the C-ABI/Bun surface).
- Enrollment window UX when multiple devices race the same code (should be single-use → second attempt fails cleanly).
- Whether legacy TLS listener is kept at all in the end state or removed once Noise is the transport.
- Rekey trigger: time-based, bytes-based, or both.

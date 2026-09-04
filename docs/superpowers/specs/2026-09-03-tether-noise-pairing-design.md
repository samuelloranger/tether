# Tether security rework — Noise pairing & keypair auth (foundation)

**Status:** design / revised after external review (2026-09-03) / pending operator spec review
**Date:** 2026-09-03
**Scope:** the *foundation* sub-project of the larger "make Tether safe to expose" rework. Signed updates, external audit, and at-rest encryption are separate sub-projects noted under [Decomposition](#security-target--decomposition).

> **Revision note.** A read-only external review flagged that the first draft secured the PTY/WebSocket but hand-waved (1) the rest of the REST API, (2) the coexist-migration downgrade path, (3) host-side enrollment confirmation + PSK derivation, (4) the FFI/session-state machine, plus several medium issues. This revision writes those in. The design *direction* (per-device keypairs + Noise XXpsk2/IK) held; the holes were everything around it.

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
- **E2E transport for the *whole* API.** Every `/api/*` operation — not just the PTY stream — confidential + tamper-proof + MITM-proof on first contact, *independent of the TLS PKI*.
- **Per-device keypair auth.** Enrollment issues each device its own keypair; no replayable secret on the wire; per-device revocation.
- **Kill the shared password** as a credential entirely.

## Non-goals

- **Hiding the live PTY from a compromised server.** The server runs the shell; it inherently sees PTY bytes. Accepted and documented. E2E protects the wire and pairing — not the host against itself.
- **At-rest encryption of the SQLite log.** Explicitly deferred (operator chose "accept server-trust limit"). Separate sub-project.
- **Multi-user identity / RBAC.** One operator, many devices. Not accounts.
- **No-open-port rendezvous relay.** Cut — see [Decomposition](#security-target--decomposition). No-inbound-port access is delivered by documenting existing tunnels (Tailscale / WireGuard / Cloudflare Tunnel).

## Trust model (the reframe)

The new root of trust is **shell access to the host**. Whoever can run `tether pair` on the machine can enroll a device. This is the SSH `authorized_keys` model applied to shells:

- No shared secret exists to leak, phish, or brute-force.
- The server keeps a registry of **authorized device public keys** (analogous to `~/.ssh/authorized_keys`).
- A device authenticates by proving possession of its private key during a Noise handshake — never by sending a reusable secret.

## Architecture

### One crypto core (`snow` via FFI)

Clients already share a Rust core (`crates/tether-core`) exposed to Swift via `crates/tether-ffi` (UniFFI) and to the Tauri desktop directly. The Bun server links Rust through Bun FFI.

Decision: implement the Noise handshake **once**, in Rust, using the audited [`snow`](https://docs.rs/snow) crate, in `tether-core`. Expose it to iOS (existing `tether-ffi` XCFramework), desktop (`tether-core` linked in `src-tauri`), and the **server** (Bun FFI over a small C ABI). No hand-rolled cryptography in TypeScript, ever. One implementation to audit.

### Frozen cipher suites (no negotiation)

Both suites are **fixed constants, never negotiated** — negotiation is a downgrade surface. A version string is bound into every handshake as the Noise **prologue** (`tether-noise/1`); a mismatch is a hard failure, not a fallback. Changing a suite later means bumping the prologue to `tether-noise/2`, which old and new peers refuse to cross.

- **Pairing:** `Noise_XXpsk2_25519_ChaChaPoly_BLAKE2s`. `XX` because neither side yet knows the other's static key; `psk2` mixes the enrollment secret (see [PSK derivation](#psk-derivation)) so a party without the code cannot complete the handshake. The device learns and pins the server's static public key during the handshake.
  - *Known property (not a break):* in `XX` the server transmits its static key in message 2, encrypted only under the ephemeral DH — so an on-path observer can learn the server's static key **without** the code. This is SSH-like and fine: the code still gates *completing* the handshake and *enrolling*. Knowing the server's public key authorizes nothing.
- **Reconnect (steady state):** `Noise_IK_25519_ChaChaPoly_BLAKE2s`. The device presents its authorized static key; the server is already pinned. No code, no PSK, no MITM window. Every connection after the first.

### IK completion is not authorization

`snow` will complete an `IK` handshake for **any** initiator static key. Completing the handshake proves only key possession, not authorization. Therefore: after the handshake completes, the server **looks up the initiator's static key in the device registry and drops the connection before any application data if it is absent or revoked** — fail-closed, no session object created, and with an error indistinguishable from other handshake failures (no oracle confirming "valid server, wrong device"). This check is the actual authorization gate.

### The Noise channel carries the *entire* API (not just the PTY)

**This is the correction to the first draft's central gap.** Today every `/api/*` route (sessions, git, files, upload, config, admin, push register) is a Hono REST endpoint gated by `Authorization: Bearer <password>`. Wrapping only the WebSocket would leave that whole surface on a replayable secret. Instead:

- A paired client opens **one Noise-secured channel** (the WebSocket, upgraded and then immediately running the `IK` handshake as its first bytes). All traffic after the handshake is Noise-encrypted frames.
- That channel **multiplexes** three things over length-prefixed frames: (a) request/response pairs that stand in for the old REST calls, (b) the live PTY streams, (c) server→client events. A small frame header carries `{channel-id, type}`; the server reuses the existing Hono handlers internally by dispatching a decrypted request into them, so route logic is not rewritten — only its transport and auth change.
- **Plain HTTP `/api/*` bearer routes are removed** once migration completes (see [Migration](#migration-password--keypair)). During Phase 1 they remain only for un-migrated legacy-password clients, hardened as described there.
- `/api/status` stays as a tiny **unauthenticated** endpoint (it leaks no secret) so a client can discover the server and its Noise static key fingerprint before pairing. `/api/setup` (the old password-TOFU entry) is **removed on Noise-first installs** — leaving it is an unauthenticated password backdoor. Local loopback `/control/*` tokens (present CLI, signal) are unchanged; they never leave the host.

### FFI contract (the session-state machine)

The crypto core is driven across an FFI boundary from Bun (TypeScript). This boundary is where nonce-reuse and key-leak bugs live, so the contract is explicit:

- **Opaque handle only.** The core exposes `noise_new`, `noise_write_message`/`noise_read_message` (handshake), `noise_encrypt`/`noise_decrypt` (transport), `noise_rekey`, `noise_free`. **No key, nonce, or cipher-state bytes ever cross into JS.** If JS can see key material, the "one core" property is theater — so it cannot.
- **Single owner.** Each handle is owned by exactly one logical connection; the Rust side serializes access (the nonce counter is internal). JS must never call encrypt/decrypt concurrently on one handle, nor clone a handle. Retries must **not** re-encrypt with a rewound nonce — a failed send drops the connection, it does not replay a frame.
- **Chunking.** `snow` caps a Noise message at 65535 bytes; PTY output chunks exceed that. The core (not JS) splits plaintext into ≤64 KB Noise records and reassembles on read, behind a length-prefixed application frame. JS deals only in whole application frames.
- **Rekey is in-band.** See [Session rekey](#session-rekey-forward-secrecy).
- **Packaging.** The server ships as a single `bun --compile` binary, which does **not** bundle a Rust `cdylib` automatically. The plan must specify how the shared library is delivered: either embed it as a byte asset extracted to a temp path at startup, or statically link the Noise core into a small napi/C-ABI addon loaded via `bun:ffi`. Resolve in planning; it is a build-system task, not an afterthought.

## Pairing flow

```
host:   tether pair
        → generate one-time enrollment code (12 Crockford chars) + open enrollment window
        → derive PSK = Argon2id(code, salt = serverStaticPub || windowId)  [see PSK derivation]
        → print code (grouped XXXX-XXXX-XXXX) + QR carrying {address(es), code, serverFingerprint}
        → window: single-use, ~5 min expiry, rate-limited

device: enter 12-char code + address  (desktop, typed)   OR   scan QR (phone)
        → device generates a per-host X25519 static keypair
        → Noise XXpsk2 handshake, PSK derived from the code as above
            · a party without the code cannot complete the handshake
            · device learns the server static pubkey
            → the device sends its static pubkey + a self-chosen label

host:   → PROMPT the operator:  "Device 'sam-iphone'  fp b3f8a1…  authorize? [y/N]"
        → only on 'y' is the device inserted into the registry and the window closed
        → a second racer for the same window gets a distinct "code already used / not authorized" error

device: → on host 'y': stores its private key in Keychain (iOS) / OS keyring (desktop), keyed per host
        → password never stored, never sent
        → subsequent connects use Noise IK against the pinned server static key
```

### Host-side enrollment confirmation (defeats a leaked code)

The first draft auto-authorized on the first successful handshake. That means a shoulder-surfed / screenshared / scrollback-leaked code lets an attacker win the ~5-minute race, enroll silently, and the operator's own later attempt just fails — looking like a fluke they retry. Closed by requiring an explicit host-side confirmation:

- After a handshake completes, the host **prints the proposed device's label + key fingerprint and waits for `y/N`** before inserting it into the registry. Knowing the code is necessary but not sufficient; a human at the host must approve.
- The enrollment window is consumed on the first *authorized* enrollment; concurrent racers get a distinct, non-oracle error and the operator sees both attempts.
- The code is passed **in-band after scan/type**, never as an OS-level `tether://pair?code=…` deep link (URL handlers get logged to OS recents/history). The QR is scanned inside the app; the typed path takes the code in the pairing screen. `tether://` deep links remain for *session* routing only, never for the code.

### PSK derivation

Noise's PSK is 32 bytes; the code is not fed in raw. The server derives `PSK = Argon2id(password = normalized code, salt = serverStaticPub || windowId)` with server-side parameters (resolve exact cost in planning; target ~100 ms/guess). This makes each *offline* guess of a recorded pairing handshake cost an Argon2id evaluation, so the code's raw entropy is no longer the whole story:

- **Code:** 12 Crockford base32 chars (no `0/O`, `1/I/L`) → ~60 bits, shown grouped `XXXX-XXXX-XXXX`, case-insensitive. Argon2id + the single-use/5-min window means even a much shorter code would resist online guessing; 60 bits is margin against offline work on a captured handshake.
- **Optional SAS** (high-value hosts): host terminal and device display a short word-pair derived from the handshake hash to compare by eye. Belt-and-suspenders on top of the code + host confirm.

Desktop has no camera, so the typed 12-char code is the **primary** path, not a fallback.

### Per-host device keypairs (no cross-server correlation)

A device generates a **fresh static keypair per paired host**, not one global identity. The same physical phone therefore presents different public keys to different servers, so a set of servers (or an observer of several) cannot correlate "the same device" by its key. Private keys live in Keychain/keyring keyed by `hostId`, mirroring today's per-host password storage.

### Session rekey (forward secrecy)

Noise gives per-session forward secrecy via ephemeral handshake keys. For long-lived terminal sessions, add **in-band signaled rekey**: one side sends a `rekey` control frame, both call `noise_rekey` **at that frame boundary**, and the stream continues. A time- or bytes-based *trigger* may decide *when* to send the frame, but the rekey itself is explicit and synchronized — never both sides guessing on a wall clock, which would desync the cipher state. Rekey is invisible to the PTY and must not drop bytes. Resolve the trigger threshold in planning.

## Device registry & revocation

Server-side table of authorized devices, distinct from the existing **push**-device registry (`pushDevices.ts`, push tokens). Each row: id, self-chosen label, static pubkey, fingerprint, paired-at, last-seen, last-known address.

### CLI (new verbs on the existing `main.ts` argv dispatch)

```
tether pair                             # open enrollment window → code + QR, host confirms y/N
tether devices                          # list authorized devices
tether device revoke <name|fp-prefix>   # revoke by label or fingerprint prefix
tether device rename <target> <name>    # optional
```

`tether devices` output:

```
NAME              FINGERPRINT   PAIRED        LAST SEEN     ADDRESS
sam-iphone        b3f8a1c9      2026-09-01    2m ago        100.x.x.x
desktop-homelab   7q4k92de      2026-09-03    now           127.0.0.1
```

Revoke targets a **label or fingerprint prefix**; if a prefix is ambiguous or a label matches multiple rows, the CLI refuses and lists the matches rather than guessing. Fingerprints shown are long enough (≥8 hex) that a typed prefix rarely collides.

### Revocation semantics (corrected)

Revoke must **not** tear down PTYs — killing sessions would break the persistence that is the whole product. Precisely:

- Revoke **drops that device's live WebSocket subscribers/channels only.** The detached holders and their PTYs keep running; another authorized device (or the same one, re-paired) reattaches and replays from `sinceId` as usual.
- Revoke **also deletes that device's row from the push registry** (`pushDevices`), or a revoked phone keeps receiving and decrypting notifications — the two tables are separate lifecycles and both must be cut.
- A future `IK` reconnect from the revoked key fails the registry lookup (above) and is dropped before app data.
- Revoking the last device **warns** but does not hard-block: shell access + `tether pair` is always the recovery path.
- App UI mirrors the CLI (list + swipe-to-revoke) over the same operations.

## Server static keypair lifecycle

The server has its own long-term X25519 static keypair — the identity every device pins. Its lifecycle is specified, not assumed:

- **Generation:** created on first boot into `~/.tether/config/noise/` (private key `0600` inside a `0700` dir; Windows ACLs as `x509.ts`/`tlsStore.ts` already do for the TLS key).
- **Never auto-rotated:** every paired device pins it; silently minting a new one locks all of them out (same discipline as the TLS cert today).
- **Theft = MITM of every future IK reconnect.** It is as sensitive as the TLS private key and stored the same way.
- **Rotation is an explicit operator action** (`tether rotate-identity`, resolve name in planning) that invalidates all pins and forces every device to re-pair — the deliberate, recoverable path if the key is believed compromised.

## Migration (password → keypair) — and its downgrade rules

Mirror the existing TLS cutover (`TETHER_TLS: both → only`), but with explicit anti-downgrade rules, because "both auth methods on the same port" is otherwise a downgrade oracle:

- **Phase 1 — coexist, hardened.** Keypair auth ships alongside legacy password auth so un-migrated clients keep working. But:
  - A client that has paired a keypair for a host **uses IK only and never falls back to password** for that host — a MITM cannot force it down to the password path.
  - Legacy password auth is **rate-limited and lockout-protected** exactly like the enrollment surface (the first draft rate-limited only enrollment).
  - **Phase 1 is documented as *not* internet-exposable.** While the password path is reachable, scanners and on-path attackers still have a target; keep it on a tunnel/LAN until the flip.
- **Phase 2 — flip (irreversible).** A host-side switch (`TETHER_LEGACY_PASSWORD=off`, matching the `TETHER_TLS` shape) removes the password code path, `set-password` and `/api/setup` with it. End state: no shared secret anywhere, plain-HTTP bearer routes gone.

Fresh installs skip Phase 1: first-run is `tether pair`, never `set-password`.

## Hardening (rides along)

- **Drop the plaintext default.** New installs default to no plaintext listener; `TETHER_TLS=off` becomes an explicit opt-out.
- **CORS — allowlist, don't blanket-deny.** The Tauri desktop webview sends an `Origin`; a naive "reject all cross-origin" would break it. Scope CORS to the known webview origin(s) and nothing else, rather than `*` or a blind deny. (Native iOS and the server-internal dispatch are unaffected; this is about the desktop webview only.)
- **Rate-limit both guessable surfaces** — the enrollment code *and* (during Phase 1) legacy password auth: per-source and global attempt caps on top of single-use/expiry.
- **Security headers** on any HTTP surface that remains.

## Affected components (blast radius)

- **`crates/tether-core`** — Noise module (`snow`): frozen suites + prologue, XXpsk2 pairing + IK reconnect state machines, Argon2id PSK derivation, per-host keypair generation, server-key pinning, chunking + in-band rekey, the opaque-handle FFI surface.
- **`crates/tether-ffi`** (or a new `tether-noise-ffi`) — C ABI for the Bun server; the packaging path for shipping the library inside `bun --compile`.
- **`apps/server/src/server/`** — `auth.ts` (Noise-authed device identity + registry lookup gate, replacing bearer middleware), `app.ts` (WS gateway runs IK then multiplexes all API traffic as Noise frames; internal dispatch into existing Hono handlers), `db.ts` (device registry + migration), `main.ts` (`pair`/`devices`/`device`/`rotate-identity` verbs + host-side confirm prompt), remove `/api/setup` on Noise-first, `pushDevices.ts` (revoke deletes push rows), CORS config, `x509.ts`/`tlsStore.ts` (TLS demoted to defence-in-depth; new `noise/` keystore alongside).
- **iOS (`clients/apple`)** — replace stored-password model (`HostStoreAdapter.password`, `NativeHostClient(profile, password)`, ~20 call sites) with per-host keypair in Keychain + the Noise client channel; pairing UI (scan/enter code); device management UI.
- **Desktop (`apps/desktop`)** — same credential swap in `src-tauri` (keyring) + Noise client; typed-code pairing UI; device management UI.
- **Deep-link scheme (`crates/tether-core/src/deep_link.rs`)** — unchanged for session routing; explicitly **not** used to carry pairing codes.
- **Docs** — rewrite `docs/security.md`, `docs/privacy.md` transport sections; add a tunnels-for-no-open-port page.

## Testing strategy

- **Rust core:** XXpsk2 success; wrong-code failure; suite/prologue mismatch hard-fails (no downgrade); IK reconnect against pinned key; **IK from an unregistered key is dropped before app data with no distinguishing error**; tampered-frame rejection; >64 KB chunk round-trip; in-band rekey mid-stream keeps the byte stream intact; Argon2id PSK determinism + salt binding; per-host keypairs differ across hosts.
- **Server (bun:test):** enrollment window single-use/expiry/rate-limit; **host-confirm gate (no insert without `y`)**; race-loser gets the non-oracle error; **every `/api/*` operation refuses outside the Noise channel**; `/api/setup` absent on Noise-first; device registry CRUD; **revoke drops WS subscribers but the holder/PTY survives and replays**; **revoke deletes the push row**; migration: paired client refuses password fallback; legacy password rate-limited; CORS allows the webview origin and rejects others.
- **Cross-stack:** pair a simulated device end-to-end (Rust client ↔ Bun server FFI), confirm at the host, exchange an API request/response and a PTY frame over the one channel.
- **Downgrade negative test:** a MITM that strips Noise / offers only the password path cannot get a keypair-paired client to authenticate.

## Security target & decomposition

Honest scoring (a shell host is inherently trusted, so 10/10 does not exist; ~9 is the realistic ceiling for tether's own code):

- **Foundation as specced (this doc):** ~8.5/10.
- **+ signed updates + the folded-in hardening:** ~8.8/10.
- **+ externally audited:** ~9/10.

**No-open-port exposure is a deployment concern, not a tether feature.** A rendezvous relay was considered and **cut** — it would require publicly-hosted, bandwidth-heavy infrastructure (forwarding continuous terminal I/O), which this project will not take on. The no-inbound-port path is delivered by **documenting existing tunnels** (Tailscale / WireGuard / Cloudflare Tunnel) — hosted zero-knowledge relays users already run for free. The foundation's Noise E2E rides safely over any of them.

Downstream sub-projects, each its own spec → plan cycle:

1. **Signed, verified updates** — `tether update` verifies a minisign/cosign signature over the binary against a key baked into the client. Closes the supply-chain path that bypasses all auth work.
2. **External protocol/crypto audit + handshake/frame fuzzing** — the gate before any public "internet-safe" / "audited" claim.
3. **No-port exposure docs** — a "reach your server from anywhere" tunnels page. Documentation, not code.
4. **At-rest encryption** — deferred by operator decision.

## Open questions (resolve during planning)

- Argon2id cost parameters for PSK derivation (target per-guess cost vs. host CPU on a low-end box).
- Bun-server FFI packaging: embed-and-extract the `cdylib` vs. statically link into a `bun:ffi`/napi addon inside `bun --compile`.
- Whether the Bun-server FFI reuses `tether-ffi` or gets a dedicated `tether-noise-ffi` crate.
- Rekey trigger threshold (time, bytes, or both) — the mechanism is settled (in-band), only the trigger is open.
- Whether the legacy TLS listener is kept at all in the end state or removed once Noise is the transport.
- Exact wording/behavior of `rotate-identity` and its re-pair-everyone flow.

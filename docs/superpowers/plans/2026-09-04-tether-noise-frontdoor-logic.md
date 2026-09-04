# Tether Noise Front-Door Logic (Plan 2c-logic of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** The testable server-side *logic* of the new front door, with no `app.ts`/`Bun.serve` wiring: (1) load-or-create the server's long-term Noise static keypair on disk; (2) an in-memory enrollment window (code + PSK + single-use + expiry + rate-limit) and a pairing orchestrator that runs `acceptPairing` + host-confirm + `addDevice`; (3) a reconnect auth gate that runs `acceptReconnect` against the registry + `touchDevice`. Everything is exercised in-process with a synthetic Noise client (the `noiseFfi` binding), so it needs no iOS/desktop client and touches no fragile gateway code.

**Architecture:** Three new server modules consuming Plan 2b (`deviceRegistry`) and Plan 2c-core (`noiseChannel`, `noiseFfi`). `app.ts` glue, `/api/*` multiplexing, password removal, and cdylib packaging are explicitly deferred to the final 2c wiring plan (they cannot be integration-tested until the clients speak Noise).

**Tech Stack:** Bun + TypeScript, `bun:test`, `node:fs` for the keystore.

**Spec:** `docs/superpowers/specs/2026-09-03-tether-noise-pairing-design.md` (server static keypair lifecycle; enrollment window; host-confirm; IK≠authz).

## Global Constraints

- **Server static keypair** lives under `~/.tether/config/noise/` — `server.pub` and `server.key`; the private key file is created `0600`. Never auto-rotated. A test injects a temp dir.
- **Enrollment code:** 12 Crockford base32 chars, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, generated from a CSPRNG. The PSK is `derivePsk(code)` (the FFI derivation from Plan 2a, which normalizes + Argon2id internally).
- **Enrollment window:** single-use (consumed on first successful, host-confirmed enroll), ~5-min expiry, and a per-window attempt cap (a wrong-code / failed handshake counts as an attempt; exhausting the cap closes the window). At most one window open at a time; opening again replaces any prior.
- **IK completion ≠ authorization:** the reconnect gate authorizes via `deviceRegistry.getDeviceByPubkey`; a null result is a closed connection with no transport (inherited from `acceptReconnect`).
- Injected clock + registry where it makes tests deterministic. Colocated tests. Biome: 2-space, single quotes, semicolons, width 100.

---

## File Structure

- Create `apps/server/src/server/noiseIdentity.ts` — load-or-create the server static keypair on disk.
- Create `apps/server/src/server/noiseIdentity.test.ts`.
- Create `apps/server/src/server/enrollment.ts` — code generation, the `EnrollmentWindow`, and `runPairing`.
- Create `apps/server/src/server/enrollment.test.ts`.
- Create `apps/server/src/server/authGate.ts` — `runReconnect`.
- Create `apps/server/src/server/authGate.test.ts`.

---

## Task 1: server static keypair on disk

**Files:** Create `noiseIdentity.ts`, `noiseIdentity.test.ts`.

**Interfaces:**
- Produces: `loadOrCreateServerKeypair(dir?: string): { pub: Uint8Array; priv: Uint8Array }` — reads `server.pub`/`server.key` from `dir` (default `<config>/noise`), or generates via `genKeypair()` and writes them (`server.key` mode `0600`, dir mode `0700`). Idempotent: a second call returns the same bytes. `serverFingerprint(pub: Uint8Array): string` — lowercase hex `SHA-256(pub)`.

- [ ] **Step 1: Write failing tests.** In a temp dir (`fs.mkdtempSync`): first call creates both files and returns 32-byte keys; a second call returns identical bytes (persisted, not regenerated); `server.key` has mode `0600` (check `statSync(...).mode & 0o777 === 0o600`; guard the mode assertion behind `process.platform !== 'win32'`); `serverFingerprint` is 64 hex chars and stable.

- [ ] **Step 2: Run → FAIL.** `bun --cwd apps/server test noiseIdentity`

- [ ] **Step 3: Implement.** Use `genKeypair()` from `./noiseFfi`. Store keys base64 in the two files. `mkdirSync(dir, { recursive: true, mode: 0o700 })`; `writeFileSync(keyPath, b64, { mode: 0o600 })`. On read, `readFileSync` + `Buffer.from(b64, 'base64')` → `Uint8Array`. Fingerprint via `new Bun.CryptoHasher('sha256').update(Buffer.from(pub)).digest('hex')`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.** `git commit -am "feat(noise): load-or-create server static keypair on disk"`

---

## Task 2: enrollment code + window

**Files:** Create `enrollment.ts`, `enrollment.test.ts`.

**Interfaces:**
- Produces:
  - `generateCode(): string` — 12 Crockford chars from `crypto.getRandomValues`.
  - `class EnrollmentWindow` with:
    - `constructor(opts?: { ttlMs?: number; maxAttempts?: number; now?: () => number })` (defaults: `ttlMs = 5 * 60_000`, `maxAttempts = 5`, `now = Date.now`).
    - `open(): { code: string; expiresAt: number }` — generates a code, derives+caches its PSK (`derivePsk(code)`), resets attempts, returns the code + expiry. Replaces any prior open window.
    - `isOpen(): boolean` — open, unexpired, attempts remaining, not yet consumed.
    - `psk(): Uint8Array` — throws if not open.
    - `recordAttempt(): void` — increments the attempt counter (call on a failed enroll); closes the window when `maxAttempts` is reached.
    - `consume(): void` — marks the window used (called after a successful enroll); `isOpen()` is false afterward.
    - `close(): void`.

- [ ] **Step 1: Write failing tests.** `generateCode` returns 12 chars all in the alphabet, and two calls differ. `EnrollmentWindow`: after `open()`, `isOpen()` is true and `psk()` returns 32 bytes; advancing an injected clock past `ttlMs` makes `isOpen()` false and `psk()` throw; `recordAttempt()` called `maxAttempts` times closes it; `consume()` closes it; a fresh window (never opened) is not open. Use a mutable `now` closure for the clock.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `generateCode`: map random bytes to the alphabet (`256 % 32 === 0`, unbiased modulo). The window stores `{ code, psk, expiresAt, attempts, consumed }` or null. `isOpen` checks all conditions against `now()`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.** `git commit -am "feat(enrollment): code generator + single-use enrollment window"`

---

## Task 3: `runPairing` orchestrator

**Files:** Modify `enrollment.ts`, `enrollment.test.ts`.

**Interfaces:**
- Produces:
  - `interface PairingDeps { addDevice: (input: { label: string; pubkey: string; address?: string }) => { pubkey: string }; confirm: (proposal: { pubkeyBase64: string; fingerprint: string }) => boolean | Promise<boolean>; label: string; address?: string; }`
  - `async function runPairing(io: FrameIO, serverPriv: Uint8Array, window: EnrollmentWindow, deps: PairingDeps): Promise<{ pubkey: string }>` — throws `PairingError('window_closed' | 'rejected' | 'handshake')`.
  - `class PairingError extends Error { constructor(public code: 'window_closed' | 'rejected' | 'handshake'); }`

  Flow: if `!window.isOpen()` → throw `window_closed`. Else call `acceptPairing(io, serverPriv, { psk: window.psk(), confirm: (p) => deps.confirm({ pubkeyBase64: p.pubkeyBase64, fingerprint: fp(p.pubkeyBase64) }) })`. On `ChannelError('rejected')` → `window.recordAttempt()` and rethrow as `PairingError('rejected')`. On `ChannelError('handshake')` (wrong code) → `window.recordAttempt()` and rethrow as `PairingError('handshake')`. On success → `deps.addDevice({ label: deps.label, pubkey: devicePubkey, address: deps.address })`, then `window.consume()`, return `{ pubkey: devicePubkey }`. `fp` = lowercase hex `SHA-256` of the raw pubkey bytes (matches the registry fingerprint).

- [ ] **Step 1: Write failing tests** using the in-process `pipe()` helper (copy the one from `noiseChannel.test.ts`) and a `pairInitiator` device:
  - Happy path: open a window, run `runPairing` with a fake `addDevice` (records the call) + `confirm: () => true`; drive the device's 3 XXpsk2 messages using the window's code (`derivePsk(code)`); assert `addDevice` was called with the device pubkey and the window is now consumed (`isOpen()` false).
  - Closed window: a fresh (unopened) window → `runPairing` rejects `window_closed` before any handshake.
  - Rejected: `confirm: () => false` → rejects `rejected`, window records an attempt.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(enrollment): runPairing orchestrator (window + confirm + enroll)"`

---

## Task 4: `runReconnect` auth gate

**Files:** Create `authGate.ts`, `authGate.test.ts`.

**Interfaces:**
- Produces:
  - `interface ReconnectDeps { getDeviceByPubkey: (pubkey: string) => { id: string; pubkey: string } | null; touchDevice: (pubkey: string, address?: string) => void; address?: string; }`
  - `async function runReconnect(io: FrameIO, serverPriv: Uint8Array, deps: ReconnectDeps): Promise<{ channel: ServerChannel; device: { id: string; pubkey: string } }>` — runs `acceptReconnect` with `authorize = deps.getDeviceByPubkey`; on success calls `deps.touchDevice(device.pubkey, deps.address)` and returns the channel + device. Propagates `ChannelError('unauthorized' | 'handshake')`.

- [ ] **Step 1: Write failing tests** with `pipe()` + a `reconnectInitiator` device:
  - Authorized: a fake `getDeviceByPubkey` returning a device for the right pubkey; assert the returned `device.id`, that a frame round-trips over `channel`, and that `touchDevice` was called with the pubkey.
  - Unauthorized: `getDeviceByPubkey: () => null` → rejects with `code: 'unauthorized'` and `touchDevice` was NOT called.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (thin wrapper over `acceptReconnect`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: typecheck + biome** on all three new modules + tests. Commit. `git commit -am "feat(authGate): runReconnect gate (registry authorize + touch)"`

---

## Self-Review

- Server static keypair lifecycle (generate-once, `0600`, fingerprint) → Task 1. ✅
- Enrollment window: single-use, expiry, rate-limit, PSK from code → Task 2. ✅
- Pairing orchestrator: window check + host-confirm + enroll + consume → Task 3. ✅
- Reconnect gate: registry authorize (IK≠authz) + touch → Task 4. ✅
- Everything tested in-process against a synthetic Noise client; no `app.ts`, no real client needed. ✅
- **Deferred to the final 2c wiring plan:** mounting `runPairing` behind a `tether pair` daemon control endpoint + relaying host-confirm to the CLI TTY; mounting `runReconnect` in the `Bun.serve` WebSocket handler; multiplexing `/api/*` over the channel; removing the password (`auth.ts`, `/api/setup`, `admin/password`); embedding the cdylib in the `bun --compile` binary. These need the clients (Plans 3–4) to speak Noise before they can be integration-tested, so they are intentionally not attempted blind here.

## Execution Handoff

Plan 2c-logic. After this, the front door is fully logic-complete and tested; what remains is the thin (but client-coupled) gateway glue + password removal + packaging, best done alongside or after the client plans.

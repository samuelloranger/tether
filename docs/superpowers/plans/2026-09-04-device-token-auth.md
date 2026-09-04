# Per-device Auth Tokens — Implementation Plan

> **For agentic workers:** implement task-by-task (TDD, frequent commits). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the shared-password REST auth with a per-device bearer token a paired device mints over its Noise channel, so the password can be removed.

**Architecture:** A stateless HMAC token `{deviceId, iat, exp}` signed with a per-server secret. A paired device requests one over the already-authenticated Noise session (`{t:'auth.token'}`); it presents it as `Authorization: Bearer <token>` on normal HTTPS REST calls; `authMiddleware` verifies it (signature + not-expired + device still in the registry) instead of the password. Additive first; password removed in a later cutover.

**Tech Stack:** Bun + Hono, `bun:test`, Node `crypto` (HMAC), the existing `noiseSessionProtocol` + `deviceRegistry`. Biome (2-space, single quotes, width 100). iOS = Swift (build on the `macbuild` host); desktop = Tauri Rust + React (build locally).

**Spec:** `docs/superpowers/specs/2026-09-04-noise-rest-transport-design.md`

## Global Constraints

- Additive: `authMiddleware` must keep accepting the password until the cutover plan.
- Stateless: no token table. Revocation = the device id no longer resolves in the registry.
- Server tests: `bun --cwd apps/server run test` (never bare `bun test`, never a shared `TETHER_DB_PATH`).
- Fail-closed: an invalid/expired/revoked token is 401, never a partial grant.

---

### Task 1: Token mint/verify (`deviceToken.ts`)

**Files:** Create `apps/server/src/server/deviceToken.ts`; Test `apps/server/src/server/deviceToken.test.ts`.

**Interfaces (Produces):**
- `mintToken(deviceId: string, ttlSeconds?: number): string` — default TTL 24h.
- `verifyToken(token: string, opts?: { now?: number; deviceExists?: (id: string) => boolean }): { deviceId: string } | null` — null on bad shape/signature/expiry/unknown device. `deviceExists` defaults to the real registry (`getDeviceById` non-null); injectable for tests. `now` injectable for expiry tests.
- `looksLikeToken(value: string): boolean` — true iff value matches the `<b64url>.<b64url>` token shape (so the middleware skips an argon2 verify on it).

The secret: a per-server 32-byte key persisted at `~/.tether/config/noise/auth.secret` (same dir as the Noise server keypair), generated once (0600), loaded lazily. Payload JSON `{ v:1, sub, iat, exp }`, base64url-encoded; signature = HMAC-SHA256(payload, secret), base64url; token = `payload + '.' + sig`. Constant-time compare the signature (`crypto.timingSafeEqual`).

- [ ] Step 1: failing tests — round-trip (mint→verify returns the deviceId); tampered payload/sig → null; expired (`now` past `exp`) → null; unknown device (`deviceExists` returns false) → null; `looksLikeToken` true for a minted token, false for a plain password like `hunter2`.
- [ ] Step 2: run, expect fail (module missing).
- [ ] Step 3: implement `deviceToken.ts` per the interfaces above.
- [ ] Step 4: run, expect pass.
- [ ] Step 5: commit `feat(noise): per-device auth token mint/verify`.

### Task 2: Mint over the Noise session (`auth.token` message)

**Files:** Modify `apps/server/src/server/noiseSessionProtocol.ts`; Test `apps/server/src/server/noiseSessionProtocol.test.ts`.

Extend the `ClientMessage` union with `{ t: 'auth.token' }`. In the message handler (alongside `devices.list`), on `auth.token` seal back `{ t: 'auth.token', token: mintToken(identity.deviceId), expiresAt: <ISO of exp> }`. `mintToken`/the exp are injectable through the existing `SessionDeps` (add `mintToken?: (deviceId: string) => { token: string; expiresAt: string }`, default to the real `deviceToken` mint). Reuse the existing `identity.deviceId` already threaded in.

- [ ] Step 1: failing test — a fake channel receives `{t:'auth.token'}`, the loop seals back a `{t:'auth.token', token, expiresAt}` whose `token` the injected mint produced.
- [ ] Step 2: run, expect fail.
- [ ] Step 3: implement the handler + `SessionDeps` addition.
- [ ] Step 4: run, expect pass; full server suite stays green.
- [ ] Step 5: commit `feat(noise): mint a device token over the Noise session`.

### Task 3: `authMiddleware` accepts device tokens

**Files:** Modify `apps/server/src/server/auth.ts`; Test `apps/server/src/server/auth.test.ts` (create if absent).

Middleware order: public path → `next`; else read the bearer; if `looksLikeToken(bearer)` and `verifyToken(bearer)` → `next`; else if `await verifyPassword(bearer)` → `next` (kept until cutover); else 401. Keep everything else unchanged.

- [ ] Step 1: failing test — invoke `authMiddleware` with a fake Hono context: a minted token (for a device the injected registry knows) passes; a tampered token 401s; a valid password still passes; a public path is exempt. (Follow the existing `authGate.test.ts`/route-test style for faking `c`.)
- [ ] Step 2: run, expect fail.
- [ ] Step 3: implement token acceptance in `authMiddleware`.
- [ ] Step 4: run, expect pass; full server suite green.
- [ ] Step 5: commit `feat(noise): authMiddleware accepts per-device tokens (additive)`.

### Task 4: Live E2E (server)

**Files:** Create `apps/server/e2e-noise-token.ts` (self-contained, spawns a temp server; copy the pair/handshake plumbing from the existing scratchpad `e2e-noise.ts`).

Flow: spawn temp server → pair → open `/api/noise/session` → send sealed `{t:'auth.token'}` → read the token → `GET /api/sessions` with `Authorization: Bearer <token>` over HTTP → assert 200. Then revoke the device (`/control/pair` has no revoke; use `tether device revoke` via the CLI, or call the registry through a control endpoint if simpler) and assert the same token now 401s.

- [ ] Step 1: write the harness.
- [ ] Step 2: run against a temp server; expect `TOKEN E2E PASSED` (200 with token; 401 after revoke).
- [ ] Step 3: commit `test(noise): live E2E — device token mints over Noise, auths REST, dies on revoke`.

### Task 5: Client integration — desktop (Tauri) [BUILD LOCALLY]

**Files:** `apps/desktop/src-tauri/src/commands/noise.rs` (a `core_noise_token(host_id, address) -> Result<String, String>` that opens a session, sends `{"t":"auth.token"}`, reads the reply, returns the token), register in `main.rs`; `apps/desktop/src/coreApi.ts` wrapper; wherever the desktop REST layer adds the `Bearer` (find it — the password path) branch to use the minted token for a Noise host, caching it and re-minting on 401.

- [ ] TDD the codec/token-request piece (Rust unit test with a fake responder, like the existing `pair_with` tests); wire the REST bearer source; `cargo test` + `bun run typecheck` + `bun run test` green. Commit.

### Task 6: Client integration — iOS [BUILD ON macbuild]

**Files:** `clients/apple/TetherKit/Sources/TetherKit/Noise/NoiseSessionClient.swift` (a `func requestToken(hostId:url:) async throws -> (token: String, expiresAt: Date)` over `NoiseChannel`); the REST `NativeHostClient` reads the cached token for a Noise host instead of the password; cache + re-mint on 401.

- [ ] Add a `NoiseChannel.sendAuthToken()` + decode `{t:'auth.token',...}` (mirror the devices messages); unit-test the decode; wire `NativeHostClient`'s bearer source; build + test on macbuild (xcodebuild TetherKit). Commit.

### Task 7: Password cutover [SEPARATE — do only on explicit go]

Delete: `authMiddleware`'s password branch, `verifyPassword`, `set-password` CLI, `/api/setup`, `needsSetup`/TOFU, `/api/status` password reporting, `/api/admin/password`. Middleware becomes token-only. Rewrite `docs/security.md`. Do NOT do this until Tasks 1–6 are shipped and Sam gives the explicit go.

## Self-Review

- Spec coverage: §3 token decisions → Task 1; §4.2 mint over Noise → Task 2; §4.3 middleware → Task 3; §4.4 clients → Tasks 5–6; §5 cutover → Task 7; §7 testing → Tasks 1–4,5,6. 
- Stateless/revocation is consistent (verify checks registry; no store). Additive is consistent (password branch kept until Task 7).

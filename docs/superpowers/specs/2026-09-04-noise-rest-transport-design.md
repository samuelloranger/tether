# Per-device auth tokens (replacing the shared password)

Status: design / spec (revised — supersedes the earlier HTTP-tunnel design)
Date: 2026-09-04
Author: pairing with Sam
Depends on: the Noise pairing + session model already shipped (per-device X25519
keypairs, IK reconnect, `/api/noise/{pair,session}`, device registry).

## 1. Problem and the pivot

Today every `/api/*` route is gated by the shared password (`authMiddleware`),
except a few public paths. We want the password gone, access scoped to paired
devices.

An earlier draft tunneled the whole REST surface *inside* Noise (sealing every
request/response) to be end-to-end even without TLS. That was overkill: the REST
endpoints (session lists, git, file reads, uploads, config) don't need to be
re-encrypted on top of HTTPS — they just need to require a paired device. The
truly-sensitive live data (the terminal) is already end-to-end over Noise and
stays that way.

So: keep REST as normal HTTPS, and replace the shared-password check with a
**per-device auth token** that a paired device obtains over its Noise channel.

## 2. Threat model (revised, honest)

The terminal stays end-to-end encrypted over Noise (unchanged). The REST surface
is an ordinary authenticated HTTPS API: **authentication** is per-device (only a
paired device holds a valid token); **confidentiality** is TLS. A hostile proxy
that terminates TLS could read a `git diff` or replay a token until it expires —
acceptable for a homelab tool meant to run behind a tunnel/LAN, which is how
Tether is deployed. This is the same posture as any token-authed HTTPS service.

## 3. Decisions (locked)

- **Auth = a per-device bearer token.** A paired device asks for a token over its
  authenticated Noise channel; presents it as `Authorization: Bearer <token>` on
  REST calls; `authMiddleware` verifies it instead of a password.
- **Stateless, signed token — no token store.** Token = a compact signed blob
  `{ deviceId, issuedAt, expiresAt }` HMAC'd with a per-server secret. Verify =
  check the signature + not-expired + **the device id is still in the registry**
  (a revoked device is deleted from the registry, so its tokens stop verifying
  immediately — revocation for free, no token table to maintain).
- **Short lifetime + silent refresh.** Tokens live ~24h. The client re-mints over
  Noise before expiry (or on a 401). No refresh tokens; the Noise keypair IS the
  long-lived credential.
- **No coexistence in the end state**, additive build: ship token-minting +
  middleware-accepts-token first (password still accepted so nothing breaks),
  migrate the clients, then remove the password in a flag-day cutover.
- **Terminal stays E2E over Noise** (out of scope for this change). Its
  metadata-parity gap (`title`/`activity`/`diff`/`reset` on the session protocol)
  is a separate, still-needed plan.
- **Config + admin**: with tokens, these are just normal token-authed REST — no
  tunnel, no special handling. `/api/admin/password` goes away with the password;
  the rest (`/api/config`, `/api/admin/{update,restart}`) can stay token-authed
  REST. (Sam's earlier "config via CLI" preference is now optional, not required —
  decide during the cutover plan.)

## 4. Architecture

```
  Pair (existing) ──► device keypair pinned both sides
        │
  Noise session (existing IK channel, already authenticated)
        │  { t:'auth.token' }  ──►  server mints + signs
        │  ◄── { t:'auth.token', token, expiresAt }
        ▼
  Device caches token, then normal HTTPS:
     GET /api/sessions   Authorization: Bearer <token>
        │
   authMiddleware.verify(token): sig ok? not expired? device still registered?
        │  yes → route runs (unchanged)      no → 401
```

### 4.1 The token

`crates`-free, server-side TS. A token is `base64url(payload) + "." +
base64url(hmacSHA256(payload, secret))` where payload is
`{ v:1, sub:<deviceId>, iat:<sec>, exp:<sec> }`. The secret is a per-server random
key persisted alongside the Noise server keypair (`~/.tether/config/noise/`),
generated once. Verification is constant-time on the HMAC, then `exp > now`, then
`getDeviceById(sub)` is non-null. New module `apps/server/src/server/deviceToken.ts`
(`mintToken(deviceId)`, `verifyToken(token) -> { deviceId } | null`), pure + unit-tested.

### 4.2 Minting over Noise

Extend the existing sealed session protocol (`noiseSessionProtocol.ts`, which
already carries `devices.list`/`devices.revoke`) with one request/response:

- client → server (sealed): `{ t: 'auth.token' }`
- server → client (sealed): `{ t: 'auth.token', token: string, expiresAt: string }`

The session channel is already IK-authenticated + registry-authorized, and the
authorized `deviceId` is already threaded in — so minting is a one-liner:
`mintToken(identity.deviceId)`. No new endpoint. A device that only needs REST
opens a session, requests a token, and may close it.

### 4.3 Middleware

`authMiddleware` gains token acceptance:

```
if PUBLIC_API_PATHS.has(path): next()
token = bearer(header)
if token and verifyToken(token): next()            // device token — the new path
else if token and await verifyPassword(token): next()  // password — removed at cutover
else: 401
```

A `verifyToken` that also matches the `<payload>.<sig>` shape avoids paying an
argon2 verify on a token that is obviously not a password. Order: try the token
shape first, fall back to password.

### 4.4 Client changes (small)

Both clients already send `Authorization: Bearer <password>` on REST. Change the
*source* of that value from the stored password to a minted device token:

- On connect to a Noise host, open the session, send `auth.token`, cache the
  `{token, expiresAt}` (in memory; re-mint on expiry or a 401).
- The REST layer (`NativeHostClient` on iOS, the desktop REST fetch) reads the
  cached token instead of the password for a Noise host. Password hosts are
  unaffected until the cutover.
- A 401 triggers one silent re-mint + retry; a second 401 surfaces as
  auth-failed.

## 5. The cutover (flag day), ordered

1. Server: `deviceToken.ts` + `auth.token` session message + middleware accepts
   tokens (additive; password still works).
2. Clients: mint + use tokens for Noise hosts.
3. Coordinated release. Once every client is on tokens:
4. Delete the password: `authMiddleware`'s password branch, `verifyPassword`,
   `set-password` CLI, `/api/setup`, the TOFU `needsSetup` flow, `/api/status`'s
   password reporting, `/api/admin/password`. Middleware becomes token-only.
5. Rewrite `docs/security.md`: no shared password; access is per-device tokens
   minted over Noise; confidentiality is TLS; the terminal is E2E over Noise.

## 6. Error handling

- Bad/expired token → 401; client re-mints once over Noise, retries; a second
  failure surfaces.
- Revoked device → its `deviceId` is gone from the registry, so `verifyToken`
  returns null → 401 on the very next request (no token store to purge).
- Clock skew → `exp` uses server time; the client trusts `expiresAt` from the
  mint response and refreshes a bit early (e.g., at 90% of lifetime).
- Secret rotation (rare/manual): rotating the HMAC secret invalidates all tokens;
  clients re-mint on the resulting 401. No migration needed.

## 7. Testing

- Unit: `mintToken`/`verifyToken` round-trip; tampered sig rejected; expired
  rejected; unknown/revoked `deviceId` rejected (inject a fake registry lookup).
- Unit: `authMiddleware` — a valid token passes, a forged token 401s, the
  password still passes (pre-cutover), a public path is exempt.
- Integration: `auth.token` over a fake session channel returns a token that
  `verifyToken` accepts.
- Live E2E (env-gated, homelab pattern): pair → open session → `auth.token` →
  `GET /api/sessions` with the token → 200; revoke the device → the same token
  now 401s (fail-closed).

## 8. Out of scope

Per-device permission tiers; refresh tokens; changing the terminal transport
(already Noise); the terminal metadata-parity plan; a rendezvous relay (dropped).
Whether config/admin move to the CLI is deferred to the cutover plan.

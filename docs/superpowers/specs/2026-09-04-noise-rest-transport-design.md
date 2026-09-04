# Noise-authenticated REST transport (and the password cutover)

Status: design / spec
Date: 2026-09-04
Author: pairing with Sam
Depends on: the Noise pairing + session model already shipped (per-device X25519
keypairs, IK reconnect, `/api/noise/{pair,session}`, device registry, devices
list/revoke over the session).

## 1. Problem

Today `authMiddleware` gates every `/api/*` route behind the shared password,
except four public paths (`/api/status`, `/api/setup`, `/api/noise/pair`,
`/api/noise/session`). Noise currently carries only two things: the terminal
session (`output`/`exit` + `start`/`input`/`resize`) and device management
(`devices.list`/`devices.revoke`). Everything else — sessions list/start/kill,
git, file read, upload, presentations, push registration — is still
password-only over plain REST. That is why the password cannot yet be removed:
deleting `authMiddleware` would leave those routes unauthenticated (open to
anyone on the port) or force deleting the features.

Goal: carry the full **client-facing** REST surface over the authenticated
Noise channel so the shared password can be removed entirely.

## 2. Decisions (locked)

- **Transport: HTTP tunnel over Noise.** Hono is Web-standard (`app.fetch(Request)
  -> Response`). A client serializes an HTTP request, seals it over Noise; the
  server opens it, runs `app.fetch` against the *existing* route handlers, and
  seals the response back. No per-endpoint message types; server routes and
  client `fetch` call-sites keep their shapes — only the transport beneath them
  changes.
- **No coexistence — flag day.** This is not additive-forever. The end state is
  Noise-only: the password (`authMiddleware`, `set-password`, `/api/setup`,
  `/api/admin/password`, the TOFU `needsSetup` flow) is deleted in the same
  effort, in one coordinated release across server + iOS + desktop. Old clients
  stop working; that is accepted.
- **Config + admin move to the host CLI**, off the remote surface entirely.
  `/api/config` (PATCH) and `/api/admin/{update,restart,test-notification}`
  become `tether` CLI operations on the host, reusing the existing loopback
  present-control-token pattern. They never travel over Noise. `/api/admin/password`
  disappears with the password.
- **Remote Noise surface** (what the tunnel must carry): `/api/sessions`
  (list/start/kill/rename), `/api/sessions/:id/{logs,diff,diff/file,diff/summary,
  git/*,file,upload}`, `/api/presentations`, `/api/push/{register,unregister}`,
  plus the already-built terminal + devices. `/api/health` stays a trivial
  unauthenticated liveness route.

## 3. Threat model

Internet-exposable + end-to-end. Confidentiality and authentication are the
Noise layer's job, NOT TLS — a request must be unreadable and unforgeable to
anyone who is not a paired device, even if TLS is absent or terminated by a
proxy. Consequences: every tunneled request/response is sealed; authorization is
by device keypair (registry lookup), fail-closed; TLS becomes optional (nice for
`https://` URLs and ATS on iOS, but not a security dependency).

## 4. Architecture

Three layers, client and server mirror each other:

```
  REST call-site (client)                     Hono routes (server, unchanged)
        | fetch-shaped request                        ^ Response
   ┌────▼─────────────┐                          ┌────┴───────────────┐
   │ NoiseHttp client │  serialize + reqId       │ NoiseHttp server   │
   │  (mux + chunk)   │─────────────────────────▶│  app.fetch(Request)│
   └────┬─────────────┘   sealed frames          └────┬───────────────┘
        │                                              │
   ┌────▼─────────────────────  Noise channel  ────────▼───────────────┐
   │ IK-authenticated, registry-authorized (fail-closed) — the same    │
   │ handshake the terminal/devices use. One RPC channel per host.     │
   └───────────────────────────────────────────────────────────────────┘
```

### 4.1 The RPC channel

A new endpoint `GET /api/noise/rpc` (WS upgrade), authenticated exactly like
`/api/noise/session`: IK reconnect → registry lookup by pinned device pubkey →
fail-closed before any app data. It is a **separate** channel from the terminal
session (a host may have several terminals plus REST in flight), and it
multiplexes concurrent requests. Reuse `authGate.runReconnect` +
`ServerChannel`/`FrameIO`; thread the authorized device identity in for
per-device authorization/audit.

One long-lived RPC channel per host, opened lazily on the first REST call and
kept warm; re-established on drop with the same backoff the terminal pump uses.

### 4.2 Wire framing

Every request and response is a sealed envelope. Requests and responses are
multiplexed by `id`; large bodies are split into ordered chunks (a single Noise
record caps at 65535 bytes, and uploads/file reads exceed that).

Client → server:
- `{ t:'req', id, method, path, headers, bodyLen }` — request head (path includes
  query string; headers is a small map, minus Authorization which no longer
  exists).
- `{ t:'req.body', id, seq, chunk }` — 0..N ordered body chunks (base64 or raw
  bytes per the frame codec), for non-empty bodies (upload, POST/PATCH).
- `{ t:'req.end', id }` — body complete.
- `{ t:'req.cancel', id }` — client abandoned the request.

Server → client:
- `{ t:'res', id, status, headers, bodyLen? }` — response head.
- `{ t:'res.body', id, seq, chunk }` — 0..N ordered body chunks.
- `{ t:'res.end', id }` — response complete.
- `{ t:'res.error', id, message }` — transport-level failure (distinct from an
  HTTP error status, which is a normal `res`).

`id` is a per-channel monotonic u32 from the client. `seq` orders chunks per id.
Chunk size is bounded well under the FFI transport buffer (reuse the existing
`MAX_OUTPUT_CHARS`-style cap). A hard per-request byte ceiling and an in-flight
request cap protect the server (mirror the DoS caps already added to the session
endpoint).

### 4.3 Server dispatch

On `req.end` (or immediately for bodyless requests), reconstruct a standard
`Request` (method, `https://noise.local<path>`, headers, a `ReadableStream` body
fed by the buffered/streamed chunks) and call `app.fetch(request)`. Stream the
returned `Response` back as `res` + `res.body` chunks. Because the request
arrived through an authenticated Noise channel, it bypasses `authMiddleware`
(which is being deleted anyway); a thin server-side guard still rejects paths not
on the allowed remote surface (defense in depth — e.g., never tunnel `/api/config`
or `/api/admin`).

### 4.4 Client integration

A `NoiseHttp` client exposes a `fetch`-shaped method: `noiseFetch(hostId, path,
init) -> Response`. Every existing REST call-site for a Noise host routes through
it instead of `globalThis.fetch`/`URLSession`. On desktop this is a Tauri command
(`core_noise_http`) plus a thin TS wrapper so `coreApi.ts` callers change their
transport, not their shape; on iOS a method on `NoiseSessionClient` backing the
existing `NativeHostClient` REST calls. The password `NativeHostClient` REST path
is deleted at cutover.

## 5. Closing the terminal parity gap

The Noise session protocol currently emits only `output`/`exit`. The password
terminal WS also emits `title`, `activity`, `diff`, `reset`, `ping`. For a
Noise-only world those must flow too — add them to the session protocol
(`{ t:'title'|'activity'|'diff'|'reset' , ... }`, sealed) so a Noise host gets
live titles, activity/heat, git-diff nudges, and replay resets. `ping` becomes a
keepalive on the channel. This is part of this effort, not a follow-up: without
it, Noise hosts lose those signals at cutover.

## 6. The `/preview` browser exception

`tether present` serves HTML previews at `/preview/:token/*` for a **browser** to
load. A browser cannot speak Noise, so this route cannot be part of the sealed
remote surface. Decision: `/preview` binds **loopback-only** (host-local viewing)
and is never internet-exposed. Native clients that render presentations in-app
(iOS `PresentationView`, desktop `PresentationView`) fetch the HTML over the Noise
tunnel like any other REST resource — they are not browsers. The public,
tokenized `/preview` HTTP surface is removed from the exposed listener.

## 7. The cutover (flag day), ordered

1. Ship the RPC channel + tunnel on the server (additive; password path still
   present but now redundant for Noise hosts).
2. Ship iOS + desktop routing all REST through `noiseFetch`; add the session
   protocol metadata messages; move config/admin to CLI.
3. Cut a coordinated release. Once every client is on Noise:
4. Delete `authMiddleware` and its `app.use('/api/*', ...)`, `auth.ts` password +
   token logic, `set-password` CLI, `/api/setup`, the `needsSetup`/TOFU flow,
   `/api/status` password/`secure` reporting, `/api/admin/password`. Collapse
   `PUBLIC_API_PATHS`. `/api/health` stays open; `/api/noise/*` self-authenticate.
5. Rewrite `docs/security.md`: Noise is the auth+confidentiality layer; TLS is
   optional; there is no shared password.

Because there is no coexistence, step 3 is a hard version floor — pre-cutover
clients stop working against a post-cutover server. Documented in the release
notes; enforced by a server version check that rejects the deleted routes with a
clear "upgrade your client" error rather than a bare 404.

## 8. Error handling

- Transport (channel dropped, decrypt failure, chunk overflow, in-flight cap) →
  `res.error` for pending ids + channel teardown; client retries by reopening the
  channel and re-issuing idempotent requests. Non-idempotent (POST upload) surface
  the error to the caller rather than auto-retry.
- HTTP errors (4xx/5xx from a route) are normal `res` frames — the tunnel is
  transparent to them.
- Revoked/unknown device → the IK handshake or the registry gate fails before any
  `req` is accepted (fail-closed), same as the session endpoint.
- Path not on the allowed remote surface → server replies `res` 403 without
  dispatching.

## 9. Testing

- Unit: envelope codec (req/res head + chunk ordering + reassembly), mux (two
  concurrent ids don't interleave bodies), chunking at/over the record cap,
  path-allowlist guard.
- Integration: `app.fetch` driven through an in-memory channel pair — a real
  route (`GET /api/sessions`) round-trips; an upload streams; a 404 passes
  through; a disallowed path is refused.
- Live E2E (env-gated, homelab pattern): pair → open RPC channel → `GET
  /api/sessions` over Noise returns the list; a revoked device is refused
  (fail-closed). Mirrors the existing session/devices live E2Es.
- Regression: the full server suite stays green while the tunnel is additive;
  after the cutover, the password tests are deleted with the password.

## 10. Risks / open items

- **Large uploads/downloads** over a sealed, chunked, single channel are slower
  than raw HTTP and serialize behind other RPCs on that channel. Mitigation:
  per-request chunk streaming (not buffer-whole), and consider a second RPC
  channel for bulk transfers if a single channel head-of-line blocks interactive
  calls. Measure before optimizing.
- **Streaming responses**: Tether's only true stream is the terminal (already its
  own channel). REST responses here are bounded (lists, diffs, file reads), so
  request/response framing suffices; no SSE needed.
- **Flag-day risk**: no coexistence means server + both clients must ship
  together. The version-floor rejection message is the safety net.
- **Perf of an IK handshake per channel** is amortized by keeping one warm RPC
  channel per host; only reconnects pay it.
- **Audit/authorization granularity**: the device identity is available per
  request, enabling per-device scoping later (not in scope now — all paired
  devices are equal, matching the CLI).

## 11. Out of scope

Per-device permission tiers; a rendezvous relay (explicitly dropped earlier);
browser access to the sealed surface; changing the terminal transport (already on
Noise). Config/admin remote editing is intentionally removed, not moved to the
tunnel.

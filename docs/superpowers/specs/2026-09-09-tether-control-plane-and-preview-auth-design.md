# Tether — control-plane isolation + preview auth hardening

**Date:** 2026-09-09
**Status:** design, pre-implementation
**Trigger:** an agent-generated `tether.samlo.cloud/preview/<token>/...` URL opened
in a browser with no VPN and no device pairing.

## 1. What happened (the leak path, end to end)

1. A coding agent on the tether host ran `tether present <file.html>`.
2. `presentCli.ts` POSTed to the daemon's `POST /control/presentations` (local
   control token). The daemon minted a per-preview capability URL
   `/preview/<192-bit-token>/<file>` and returned it.
3. The agent handed that URL to the user.
4. The user opened it off-VPN. It worked because `tether.samlo.cloud` (Caddy,
   `~/servers/caddy/Caddyfile:517`) reverse-proxies the **entire** tether vhost
   to the public internet with no `local-only` — so `/preview` (and everything
   else) is internet-reachable.

Nothing was unauthenticated. The capability token (192-bit, unguessable) was the
gate. The failure is **leak-by-design**: a capability URL in a chat log is a
bearer credential anyone can replay, for the life of the daemon.

## 2. Route audit (auth gate per route)

**Open, no auth — intended:**
- `GET /` — liveness, no data.
- `GET /api/status` — discovery/TLS facts, no secret (`PUBLIC_API_PATHS`).
- `GET /api/noise/{pair,session}` — Noise handshake *is* the auth ("login").

**Device-bearer gated (`authMiddleware` on `/api/*`) — correct:**
`/api/health`, `/api/config` GET+PATCH, `/api/sessions/*`, `/api/sessions/:id/{diff*,git/*,file,dir,upload,logs}`,
`/api/fs/dirs`, `/api/push/{register,unregister}`, `/api/admin/*`,
`/api/presentations` GET, `/api/presentations/:id` DELETE, `/api/ws`.

**NOT device-bearer gated — two distinct models:**

| Route | Gate | Verdict |
|---|---|---|
| `GET /preview/:token/*` | per-preview 192-bit capability token in URL | device route, under-gated → **harden** |
| `POST /control/signal` | local control token (`X-Tether-Present-Control`, `0600` file) | daemon IPC → **move off network** |
| `POST /control/presentations` (+`/reset`) | same | daemon IPC → **move off network** |
| `POST /control/pair/{open,pending,confirm,close}` | same | daemon IPC → **move off network** |

Nothing is remotely exploitable without holding a secret today. The problems are
(a) the `/preview` capability leaks trivially, and (b) the `/control/*` IPC plane
is needlessly on the public internet.

## 3. Root cause of the `/control/*` exposure

`/control/*` is not an app/device feature. It is the **daemon's IPC surface** for
the `tether` CLI subcommands (`present`, `signal`, `pair`) — separate short-lived
processes that cannot touch the long-running daemon's in-memory state directly:

| Endpoint | CLI command | Caller |
|---|---|---|
| `POST /control/presentations` | `tether present` | `presentCli.ts` |
| `POST /control/signal` | `tether signal working\|waiting\|done` | `signalCli.ts` (Claude Code hooks) |
| `POST /control/pair/*` | `tether pair` | `pairCli.ts` |

Whoever built it reused the HTTP listener the daemon already had. That single
choice: (a) put local-only IPC on `0.0.0.0`, and (b) forced the whole
`X-Tether-Present-Control` `0600`-file token dance to re-authenticate a *local*
process.

The codebase already has the correct pattern: daemon ↔ holder processes talk over
a **unix domain socket** (`~/.tether/holders/<id>.sock`, length-prefixed frames).
A unix socket is filesystem-permissioned, cannot be proxied by Caddy, and cannot
be reached off-box — so `0600` perms *are* the auth, no token needed.

## 4. Design

Three independent workstreams, split by trust tier.

### 4.1 `/control/*` → unix-socket IPC (removes exposure + token)

Move the three control endpoints off the TCP listener onto a unix domain socket,
matching the holder IPC pattern.

- Daemon opens a control socket at `~/.tether/control.sock` (dir `0700`, sock
  `0600`) alongside the existing http/https listeners in `serve.ts`.
- `present`/`signal`/`pair` CLI callers (`presentCli.ts`, `signalCli.ts`,
  `pairCli.ts`, dispatched in `main.ts`) connect to that socket via
  `fetch(url, { unix })` instead of `http://127.0.0.1:PORT/control/*`.
- Drop `X-Tether-Present-Control` and `present-control-token` entirely — the
  socket's filesystem perms replace it.
- Remove `/control/*` routes from `app.ts` route mounting. The public vhost no
  longer carries any control plane.

Reuse decision: keep the request/response shape (small JSON) and the Hono
handlers; only the transport moves (`Bun.serve({ unix })` + `fetch({ unix })`,
both proven — holder sockets use AF_UNIX, and a spike confirmed the serve/fetch
pair round-trips on Bun 1.4).

**Testing:** control commands work over the socket; a TCP request to the old
`/control/*` paths 404s; socket perms are `0600`; pairing round-trip
(`open`→`pending`→`confirm`) still works.

### 4.2 `/preview/*` → short-lived, device-minted, expiring token

`/preview` is a genuine device route (the phone/desktop webview loads it; a
webview cannot send an `Authorization` header on a top-level navigation or its
sub-resources — which is why a URL token exists at all). Keep the URL-token
mechanism but change the token's nature:

- Add `expiresAt` to each preview entry; default TTL a constant (~15 min).
- `findByToken` treats an expired entry as absent → `/preview` 404s.
- **Renewal rides the authed list.** `GET /api/presentations` is already
  bearer-gated (paired devices only). Each list call extends the still-open
  preview's `expiresAt` and returns the *same* token string. Renewal therefore
  requires the device bearer; a naked `/preview` GET cannot slide its own
  window. The token string stays stable → no iframe reload churn.
- Add `Referrer-Policy: no-referrer` to `/preview` responses so the token cannot
  leak via `Referer` to any external resource the presented HTML loads.
- No HMAC/secret needed: the in-memory registry is already the authority; expiry
  + lookup is the whole gate. Tokens already die on daemon restart.

Clients: effectively no change — both already poll `/api/presentations` every 4s
and derive the src from `preview.url`.

**Not in scope of the first plan:** narrow the preview root from the whole
`path.dirname(entry)` to the entry file + explicit allowlist (separate task).

### 4.3 Host exposure (homelab config, not app code)

Even with 4.1 + 4.2, `tether.samlo.cloud` publishes the whole vhost. Per the
project's own `docs/security.md` ("keep tether behind a tunnel or LAN-only"):

- Add `local-only` to the `tether.samlo.cloud` Caddy block, **or** front it with
  real auth (forward_auth / mTLS) if remote access is genuinely wanted.
- Consider `TETHER_TLS=only` on the host so plaintext `:8085` is not directly
  hittable on the LAN either.

## 5. Sequencing

1. **4.1** (control-plane socket) — biggest real exposure win; self-contained
   server + CLI change. **← this plan.**
2. **4.2** (preview token) — the route the user actually hit.
3. **4.3** (Caddy/host) — defense in depth; homelab-side, no app release needed.

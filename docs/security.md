# Security & networking

## The trust model

Every `/api/*` route — HTTP **and** the WebSocket upgrade — requires a shared password (`Authorization: Bearer <password>`), stored as an argon2 hash in the server's database. With no password set, the server rejects all clients. Set it with `tether set-password` or the first-run pairing flow in the app.

## Transport encryption

The server opens **two listeners**:

| Listener | Default port | Env | Encryption |
|---|---|---|---|
| Plaintext HTTP | `8085` | `TETHER_PORT` | none |
| HTTPS / WSS | `8443` | `TETHER_TLS_PORT` | TLS, self-signed cert |

On its first boot the server generates a self-signed ECDSA P-256 certificate into `~/.tether/config/tls/` (`cert.pem`, `key.pem` — the key is `0600` inside a `0700` directory) and serves TLS from it. It is valid for ten years, and it is **never rotated automatically**: clients pin its fingerprint, so silently minting a new one would lock every paired client out. If the directory is half-populated, the server refuses to start TLS rather than regenerate.

Both listeners serve the same API. That is deliberate — see [Migrating to TLS](#migrating-to-tls).

### Pinning the certificate

The certificate is self-signed, so no CA will vouch for it. Trust comes from **pinning on first contact** (TOFU), the same trust decision the password already makes:

1. `GET /api/status` (unauthenticated) returns

   ```json
   {
     "needsSetup": true,
     "secure": true,
     "tls": {
       "enabled": true,
       "plaintext": true,
       "port": 8443,
       "fingerprint": "sha256:86c3fb2a…"
     }
   }
   ```

   `POST /api/setup` echoes the same `secure` and `tls` fields, so a client can pair and pin in one round trip.

2. `secure` reports whether **that response** arrived over the TLS listener. It is derived from the socket, never from a header — `X-Forwarded-Proto` is ignored on purpose, because anything a caller can *claim* a MITM can claim too.

3. A client may only pin a fingerprint it read with `secure: true`, and must compare it against the certificate that actually terminated the connection. Over plaintext the fingerprint is **discovery data only** — useful for finding the HTTPS port, worthless as proof, because whoever can read the plaintext can rewrite it.

4. Once pinned, a fingerprint mismatch is a hard failure. It is not a re-pair prompt: the certificate does not change on its own, so a change means either an attacker or an operator who deliberately deleted the TLS directory.

Pinning on first contact is only as good as that first contact. Do the initial pairing on a network you trust — the LAN, or a tunnel.

### Migrating to TLS

`TETHER_TLS` picks the listener topology. It is **not** in `/api/config`, and cannot be changed by a client: a phone that closed the plaintext port would lock out every other client on the network, and the only recovery would be shell access to the host. `/api/config` and `/api/status` *report* the transport state; only the host's environment sets it.

| `TETHER_TLS` | Result |
|---|---|
| unset / `both` (default) | plaintext **and** TLS |
| `only` | TLS only — the plaintext port is closed |
| `off` | plaintext only — no certificate is generated or served |

The default keeps the plaintext port open, so a `tether update` changes nothing for a client that has not learned TLS yet. When every client you use has paired over HTTPS, cut over with `TETHER_TLS=only tether restart` and the plaintext port closes.

Two things to know about `only`:

- `tether status` and `tether present` follow the same setting, so they keep working over loopback TLS.
- Any client still on `http://` stops working the moment you flip it. That is the point of it being a deliberate, host-side switch.

`TETHER_TLS_EXTRA_NAMES` (comma-separated) adds extra SANs — a Tailscale name, say — but only on the boot that *generates* the certificate. Adding names later means deleting `~/.tether/config/tls/` and re-pairing every client.

## Files at rest

The sensitive files the server writes are locked to the owner: the database in `~/.tether/config/` (it holds the argon2 password hash and the session log), the TLS private key, the holder sockets, and the local control token.

- **Linux / macOS** — POSIX modes, as noted above: the key is `0600` inside a `0700` directory, and the other paths are created owner-only the same way.
- **Windows** — those modes are a no-op (`chmod` there sets only the read-only attribute, which is not a confidentiality control), so the server uses ACLs instead. It runs `icacls` to drop the inherited entries and grant the owning user alone, which is the faithful stand-in for `0600`/`0700`. See [Windows server](/windows) for the rest of the platform's differences.

Either way the guarantee is the same: another user on the machine cannot read your password hash or your TLS key.

## A tunnel is still a good idea

TLS closes the "the wire is readable" hole. It does not make the port safe to expose:

- The certificate is self-signed, so an unpinned client has no way to detect a MITM on first contact.
- CORS is still `*`, and the API exposes file read, file upload, and git write operations.
- A remote shell is a high-trust surface either way.

So: keep Tether on the LAN, or behind **Tailscale** / **WireGuard** / an **SSH** port-forward. TLS is defence in depth on top of that, not a replacement for it, and it is what makes an accidental exposure survivable instead of catastrophic.

::: warning
A remote shell is a high-trust surface. Anyone with the password and network reach gets a shell. Do not expose the port directly to the internet.
:::

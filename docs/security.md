# Security & networking

## The trust model

Every `/api/*` route — HTTP **and** the WebSocket upgrade — requires a shared password (`Authorization: Bearer <password>`), stored as an argon2 hash in the server's database. With no password set, the server rejects all clients. Set it with `tether set-password` or the first-run pairing flow in the app.

## Encryption is the tunnel's job

The password gates **access**, not the wire. Traffic is **unencrypted** — the server binds `0.0.0.0` with open CORS. Run Tether behind a tunnel for encryption:

- **Tailscale** or **WireGuard** — reach the server over the mesh/VPN.
- **SSH** — port-forward `8085` over an SSH tunnel.

Or keep it strictly LAN-only. Do not expose the port directly to the internet.

::: warning
A remote shell is a high-trust surface. Anyone with the password and network reach gets a shell.
:::

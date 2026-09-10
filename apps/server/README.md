# Tether server 📱🔌

> Persistent remote-shell backend. Real PTY shells on your host, streamed to native Tether clients over an end-to-end Noise channel, logged so clients can reconnect and replay.

**Tether** runs long-running terminal agents (`claude-code`, builds, interactive bash) persistently on your server. It solves iOS aggressively backgrounding connections (which drops WebSSH-style sessions and interrupts running agents): the shell lives in a detached holder process on the server and keeps running across client disconnects **and** server restarts.

This package is the **server only** — an API + Noise-session backend with no web UI. Clients are the native iOS app in [`clients/apple`](../../clients/apple) and the Tauri desktop app in [`apps/desktop`](../desktop).

---

## 🛠️ Architecture

- **Native Bun PTY:** shells are spawned with `Bun.spawn(..., { terminal })` (requires Bun ≥ 1.3.14) — no `node-pty`.
- **Detached holder processes:** each session's PTY lives in its own `holder` process (`main.ts holder …`) that owns a unix socket. Frames are length-prefixed binary. The Hono server attaches to it, so the shell survives server restarts; on boot the server reattaches to surviving holders.
- **Persistent SQLite log cache:** every stdout chunk is written to `bun:sqlite` with an incrementing row id (capped per session, pruned periodically).
- **Reconnect + replay:** clients send the last log id they saw as `sinceId`; the server replays everything since that id from SQLite. A prune watermark (or a byte-budget miss) tells a client to reset if its cursor predates pruned rows. Shipping clients keep `sinceId` in memory.
- **Per-device Noise auth:** pair with `tether pair`. The terminal stream is `/api/noise/session` (the handshake is the authentication). REST takes a short-lived bearer minted over that channel.

---

## 🚀 Tech Stack
- **Runtime:** [Bun](https://bun.sh) (≥ 1.3.14)
- **Server:** [Hono](https://hono.dev) + WebSockets
- **Database:** Bun native SQLite (`bun:sqlite`)
- **Formatting/Linter:** [Biome](https://biomejs.dev)

The single distributable is a `bun build --compile` binary (bin name `tether`) that is both the daemon and the control CLI.

---

## 💻 Development

From the repo root: `bun install`, then run the server from source in watch mode (port `8085`):
```bash
bun dev:server          # == bun --cwd apps/server dev
```
Dev runs use a repo-local `apps/server/config/tether.db` (isolated from any installed binary's `~/.tether/config`). Override with `TETHER_DB_PATH`.

Typecheck / lint / format:
```bash
bun --cwd apps/server typecheck
bun lint
bun format
```

---

## 📦 Production Deployment

Compile the server into a single self-contained binary (`dist/tether`):
```bash
bun run build          # == build:binary
```

Run the compiled binary:
```bash
bun run start          # ./dist/tether serve
```
It listens on port `8085` (or `process.env.TETHER_PORT`) and TLS on `8443` (`TETHER_TLS_PORT`) unless `TETHER_TLS=off`. For distribution, CI cross-compiles the release binaries (`tether-{linux,darwin}-{x64,arm64}`); end users install via [`install.sh`](../../install.sh) and manage the daemon with `tether start | stop | status | update`.

---

## 🔒 Security

Access is per-device. Pair with `tether pair`; clients mint a bearer over Noise. Traffic on the default plaintext port (`8085`) has no TLS (`0.0.0.0`, open CORS) — the terminal itself is still E2E over Noise. Run tether behind a tunnel (Tailscale / WireGuard / SSH) or keep it LAN-only. With no paired devices, every client is rejected until you enroll one.

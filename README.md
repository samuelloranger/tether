# Tether 📱🔌

> A persistent remote-shell console: real PTY shells on your server, streamed to your phone over WebSocket. Shells keep running when you disconnect — and survive server restarts.

## Install the server (no clone needed)

```bash
curl -fsSL https://raw.githubusercontent.com/samuelloranger/tether/main/install.sh | bash
```

While this repo is private, pass a GitHub token (e.g. `gh auth token`):

```bash
TOKEN=$(gh auth token)
curl -fsSL -H "Authorization: Bearer $TOKEN" \
  https://raw.githubusercontent.com/samuelloranger/tether/main/install.sh | GITHUB_TOKEN=$TOKEN bash
```

The installer checks/installs Bun (**≥ 1.3.14** — required for PTY support), downloads the server to `~/.tether/app`, symlinks the `tether` CLI into `~/.local/bin`, and starts the daemon on port `8085`. Re-running it upgrades in place; your sessions and data (`config/`) are preserved.

```bash
tether start | stop | restart | status | logs
```

Environment: `TETHER_PORT` (default 8085), `TETHER_DB_PATH`. Installer overrides: `TETHER_REF`, `TETHER_HOME`, `TETHER_BIN`.

> **Security:** the server exposes an **unauthenticated shell** on `0.0.0.0`. Anyone who can reach the port gets a shell. Keep it LAN-only or behind a VPN/tunnel.

## What you get

- **Persistent sessions** — each shell runs in a detached holder process. Client disconnects, server restarts, even `tether restart` upgrades: the shell (and whatever runs in it) keeps going.
- **Replay** — every byte is logged to SQLite; reconnecting clients catch up from where they left off, with no output lost while the server was down.
- **Mobile client** — multi-session tabs, full VT emulator (TUIs, box drawing, CJK/emoji), key repeat, search, snippets.

## Mobile app

Expo React Native (SDK 57 — Expo Go is **not** supported; use a dev build):

```bash
cd apps/mobile
npx expo run:ios --device
```

Point it at your server's IP and port on first launch.

## Development

Bun-workspaces monorepo: `apps/server` (Bun + Hono + bun:sqlite) and `apps/mobile` (Expo RN).

```bash
bun install          # link all workspaces
bun dev:server       # backend on :8085, watch mode
bun dev:mobile       # Expo Metro bundler
bun lint             # Biome (server) + Expo lint (mobile)
bun format           # biome check --write (server)
```

Tests are plain assert scripts:

```bash
cd apps/server && TETHER_DB_PATH=/tmp/tether-test.db bun run src/server/db.test.ts
cd apps/mobile && bun run src/terminal.test.ts
```

See `CLAUDE.md` for architecture notes (data flow, holder processes, conventions).

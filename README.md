# Tether 📱🔌

> A persistent remote-shell console: real PTY shells on your server, streamed to your phone over WebSocket. Shells keep running when you disconnect — and survive server restarts.

## Install the server (no clone needed)

```bash
curl -fsSL https://raw.githubusercontent.com/samuelloranger/tether/main/install.sh | bash
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

## Mobile app (iOS)

Install via [AltStore](https://altstore.io) (one-time setup: install AltServer on your Mac/PC and use it to put AltStore on your iPhone — it signs apps with your own Apple ID):

1. In AltStore: **Sources → + →** add this source:

   ```
   https://raw.githubusercontent.com/samuelloranger/tether/main/altstore.json
   ```

2. Tether appears in **Browse** — install it from there. Updates show up in AltStore automatically when a new release is published.
3. Free Apple IDs sign apps for 7 days — AltStore auto-refreshes whenever it can reach AltServer on your network.

(Manual alternative: grab `tether.ipa` from the [latest release](https://github.com/samuelloranger/tether/releases/latest) and open it via **My Apps → +** in AltStore.)

Point the app at your server's IP and port on first launch.

**Building from source instead** (Expo SDK 57 — Expo Go is *not* supported; use a dev build):

```bash
cd apps/mobile
npx expo run:ios --device
```

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

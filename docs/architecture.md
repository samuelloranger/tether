# Architecture

Tether is a Bun + TypeScript monorepo (Bun workspaces).

## Monorepo

- `apps/server/` — Bun + Hono backend. Spawns PTYs, logs to SQLite, serves the API/WebSocket. Ships as a single compiled binary that is also the `tether` CLI.
- `apps/mobile/` — Expo React Native app (iOS/Android). VT emulator, session drawer, LRU tab cache. Also the source of the **desktop** client: `apps/mobile/src-tauri` wraps the same UI in a [Tauri](https://tauri.app) window for Linux/Windows/macOS. No in-browser client (a browser can't send the password header on the WS upgrade).

## Server

- **PTY:** shells are spawned with `Bun.spawn(..., { terminal })` — requires **Bun ≥ 1.3.14**. On older Bun, `proc.terminal` is undefined and sessions die instantly.
- **Holder processes:** each session's PTY runs in its own detached *holder* (`tether holder …`) that owns a unix socket. The server attaches over that socket, so the shell outlives server restarts; on boot the server reattaches to survivors.
- **SQLite log cache:** every output chunk is written to `bun:sqlite` with an incrementing id, capped per session and pruned periodically.
- **Auth:** a Hono middleware requires the shared password on all `/api/*` routes and the WS upgrade.

## Mobile

- Full VT emulator (`src/terminal.ts`) — grid + scrollback, cursor addressing, alt-screen.
- Multiple sessions as drawer tabs; only the active tab holds a live socket + emulator; an LRU cache (cap 3) makes switching instant.
- Diff-based input so dictation/swipe/autocomplete reach the PTY.

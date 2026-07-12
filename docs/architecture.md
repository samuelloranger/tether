# Architecture

Tether is a Bun + TypeScript monorepo (Bun workspaces).

## Monorepo

- `apps/server/` — Bun + Hono backend. Spawns PTYs, logs to SQLite, serves the API/WebSocket. Ships as a single compiled binary that is also the `tether` CLI.
- `apps/mobile/` — Expo React Native app. VT emulator, session drawer, LRU tab cache. The only client (no web UI).

## Server

- **PTY:** shells are spawned with `Bun.spawn(..., { terminal })` — requires **Bun ≥ 1.3.14**. On older Bun, `proc.terminal` is undefined and sessions die instantly.
- **Holder processes:** each session's PTY runs in its own detached *holder* (`tether holder …`) that owns a unix socket. The server attaches over that socket, so the shell outlives server restarts; on boot the server reattaches to survivors.
- **SQLite log cache:** every output chunk is written to `bun:sqlite` with an incrementing id, capped per session and pruned periodically.
- **Auth:** a Hono middleware requires the shared password on all `/api/*` routes and the WS upgrade.

## Mobile

- Full VT emulator (`src/terminal.ts`) — grid + scrollback, cursor addressing, alt-screen.
- Multiple sessions as drawer tabs; only the active tab holds a live socket + emulator; an LRU cache (cap 3) makes switching instant.
- Diff-based input so dictation/swipe/autocomplete reach the PTY.

# Architecture

Tether is a Bun + TypeScript monorepo (Bun workspaces).

## Monorepo

- `apps/server/` — Bun + Hono backend. Spawns PTYs, logs to SQLite, serves the API/WebSocket. Ships as a single compiled binary that is also the `tether` CLI.
- `apps/desktop/` — the **desktop** client for Linux/Windows/macOS: a [Tauri](https://tauri.app) window over vite + [xterm.js](https://xtermjs.org), with the connection, replay, git and workspace logic in Rust.
- `clients/apple/` — the **iOS** client, native Swift/SwiftUI (`TetherKit` + `TetherIOS`), linking the same Rust core through an XCFramework.
- `crates/tether-core/` — the shared Rust core both native clients are built on: host profiles, health, WebSocket session + replay cursor, diff model, git and workspace requests. Plus `tether-proto` (wire types) and `tether-ffi` (the Swift bridge).
- `apps/relay/` — a separate Bun service that routes encrypted push payloads to APNs. It cannot read them.
- `apps/mobile/` — the Expo React Native app being retired. It was iOS + Android and, through `src-tauri`, the previous desktop client. Nothing in it is built by a release any more.

There is no in-browser client: a browser can't attach the shared secret to the WebSocket upgrade.

Android is no longer supported — builds were discontinued after v2.8.12.

## Server

- **PTY:** shells are spawned with `Bun.spawn(..., { terminal })` — requires **Bun ≥ 1.3.14**. On older Bun, `proc.terminal` is undefined and sessions die instantly.
- **Holder processes:** each session's PTY runs in its own detached *holder* (`tether holder …`) that owns a unix socket. The server attaches over that socket, so the shell outlives server restarts; on boot the server reattaches to survivors.
- **SQLite log cache:** every output chunk is written to `bun:sqlite` with an incrementing id, capped per session and pruned periodically.
- **Auth:** a Hono middleware requires the shared password on all `/api/*` routes and the WS upgrade.

## Clients

Both native clients drive the same Rust core, so session handling, replay and the git/workspace views behave identically; only the shell around them differs.

- **Transport:** the core opens the WebSocket itself and sends `Authorization: Bearer <token>`, which is what a browser cannot do.
- **Sessions:** every session is a tab. Each resident session keeps its own live socket and keeps streaming in the background; input and clipboard are gated to the active one. An LRU cache makes switching instant, and an evicted session's shell keeps running — reattaching replays from the cursor.
- **Replay cursor:** the client remembers the last row id it saw and sends it as `sinceId`, so a reconnect costs only what it missed.
- **Terminal:** desktop renders with xterm.js in the Tauri webview; iOS renders natively. Both are fed by the same parsed output.
- **Desktop updates:** the app checks on launch and installs a signed update in place. See [Desktop app](/desktop#updating).

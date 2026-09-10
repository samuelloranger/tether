# Architecture

Tether is a Bun + TypeScript monorepo (Bun workspaces) plus a small Cargo crate tree for the native clients.

## Monorepo

- `apps/server/` — Bun + Hono backend. Spawns PTYs, logs to SQLite, serves the API and the Noise session socket. Ships as a single compiled binary that is also the `tether` CLI.
- `apps/desktop/` — the **desktop** client for Linux/Windows/macOS: a [Tauri](https://tauri.app) window over vite + [xterm.js](https://xtermjs.org), with the connection, replay, git and workspace logic in Rust.
- `clients/apple/` — the **iOS** client, native Swift/SwiftUI (`TetherKit` + `TetherIOS`), linking the same Rust core through an XCFramework, plus `TetherNotificationService` (on-device push decrypt).
- `crates/tether-core/` — the shared Rust core both native clients are built on: host profiles, health, Noise session + replay cursor, diff model, git and workspace requests. Plus `tether-proto` (optional binary WS codec) and `tether-ffi` (the Swift bridge).
- `apps/relay/` — a separate Bun service that routes encrypted push payloads to APNs. It cannot read them.

There is no in-browser client: a browser can't complete a Noise handshake or attach a minted bearer to a WebSocket upgrade.

Android is no longer supported — builds were discontinued after v2.8.12. The Expo/RN client has been removed from the tree.

## Server

- **PTY:** shells are spawned with `Bun.spawn(..., { terminal })` — requires **Bun ≥ 1.3.14**. On older Bun, `proc.terminal` is undefined and sessions die instantly. Dev and CI run Bun 1.4.x.
- **Holder processes:** each session's PTY runs in its own detached *holder* (`tether holder …`) that owns a unix socket. The server attaches over that socket with length-prefixed binary frames, so the shell outlives server restarts; on boot the server reattaches to survivors.
- **SQLite log cache:** every output chunk is written to `bun:sqlite` with an incrementing id, capped per session (row + byte) and pruned periodically.
- **Auth:** pairing is `tether pair` (Noise XXpsk2). The terminal stream is a sealed Noise channel (`/api/noise/session`). REST and the leftover `/api/ws` upgrade take a per-device bearer minted over that channel. There is no shared password.
- **CLI:** `serve | start | stop | restart | status | logs | present | pair | signal | devices | device | update | version`. `holder` is internal.

## Clients

Both native clients drive the same Rust core, so session handling, replay and the git/workspace views behave identically; only the shell around them differs.

- **Transport:** the core opens `/api/noise/session` itself and completes the IK reconnect. REST calls mint `Authorization: Bearer <token>` over that channel.
- **Sessions:** every session is a tab, grouped by host. Resident sessions (the ones in the current layout) keep a live socket and keep streaming in the background; input and clipboard are gated to the focused pane. An evicted session's shell keeps running — reattaching replays from the cursor.
- **Replay cursor:** the client remembers the last row id it saw and sends it as `sinceId`. That cursor lives in memory — an app restart replays the retained tail.
- **Terminal:** desktop renders with xterm.js in the Tauri webview; iOS renders a CoreText grid fed by `alacritty_terminal` in the core.
- **Desktop updates:** the app checks on launch and installs a signed update in place. See [Desktop app](/desktop#updating).

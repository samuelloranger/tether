# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tether is a persistent remote-shell console. A Bun/Hono server spawns real PTY shell processes, streams their output over WebSocket, and logs every byte to SQLite so clients can reconnect and replay missed output. The client is an Expo React Native mobile app (the server is API/WebSocket-only — no web client).

## Monorepo layout (Bun workspaces)

- `apps/server/` — Bun + Hono backend (`tether`). PTY launcher + SQLite logger + API/WS.
  - `src/server/` — `index.ts` (Bun.serve entry), `app.ts` (Hono routes + WS gateway), `pty.ts` (process lifecycle), `db.ts` (bun:sqlite + migrations).
- `apps/mobile/` — Expo RN client (`tether-mobile`). `App.tsx` (UI + session management) + `src/terminal.ts` (VT emulator), `src/sessionCache.ts` (LRU tab cache), `src/SessionDrawer.tsx` (tab drawer).

## Commands

Run from repo root:
- `bun install` — install/link all workspaces
- `bun dev:server` — backend on `:8085` (binds `0.0.0.0`), watch mode
- `bun dev:mobile` — Expo Metro bundler
- `bun lint` — Biome check (server) + Expo lint (mobile)
- `bun format` — `biome check --write` (server only)
- `bun build:server` — compile the standalone server binary to `apps/server/dist/tether`
- `bun start:server` — run the compiled binary (`dist/tether serve`)

Server typecheck: `bun --cwd apps/server typecheck`.

**Run the backend as a background daemon:** the server ships as a single compiled binary (`bun build --compile` of `apps/server/src/server/main.ts`, bin name `tether`), installed via `install.sh` into `~/.local/bin/tether`. The binary *is* the CLI — argv dispatch: `serve` (default) runs the daemon in foreground; `start | stop | restart | status | logs | set-password | update | version` are control ops. `start` re-execs itself (`serve`) detached; pid + log live in `~/.tether/`. `tether update` downloads the latest release binary and swaps it in. Honors `TETHER_PORT` / `TETHER_DB_PATH` / `TETHER_REPO_SLUG`. Dev runs from source: `bun dev:server` (or `bun run src/server/index.ts`, which calls the same `serve()`). CI's `release.yml` ships four server binaries (`tether-{linux,darwin}-{x64,arm64}`) alongside the mobile artifacts on each `vX.Y.Z` release.
Native iOS build: `cd apps/mobile && npx expo run:ios --device` (dev build to a connected device; Expo Go doesn't support SDK 57).

There are **no tests** in this repo. There is no test runner configured.

## Runtime requirement (important)

The server's PTY relies on `Bun.spawn(..., { terminal: {...} })` and `proc.terminal`. This landed in **Bun ≥ 1.3.14**. On older Bun (e.g. 1.3.3) `proc.terminal` is `undefined`, so the spawned shell inherits stdio, hits EOF, and **dies in ~10ms** with no input path — the whole app silently fails. If sessions exit instantly, check `bun --version` first.

## Data flow (the core loop)

1. Client opens `GET /api/ws?sessionId=&sinceId=&cols=&rows=`.
2. `startSession` (`pty.ts`) spawns `Bun.spawn([command], { terminal: {...} })` — one shell per `sessionId`, held in an in-memory `Map`. Auto-starts `bash` if none exists.
3. Every PTY `data` chunk → `addTerminalLog` (SQLite, returns row id) → broadcast to all subscribers of that session.
4. On WS open the server replays `getLogs(sessionId, sinceId)` to catch the client up, then subscribes it to live output. Clients persist `sinceId` (localStorage / AsyncStorage) so a reconnect only replays what it missed.
5. Client → server messages: `{type:'input'|'resize'}`. Server → client: `{type:'output'|'exit'}`.

The **same PTY process survives client disconnects** — that's the whole point ("tether"). Killing is explicit via `POST /api/sessions/kill`.

**Mobile multi-terminal model:** The mobile app manages multiple sessions as drawer-based tabs; the server's session list (`GET /api/sessions`, which includes `last_output_at`) is the source of truth. Only the active terminal holds a live WebSocket and emulator; switching detaches background sessions (PTY keeps running server-side) and uses an LRU cache (cap 3) for instant reattach. `terminal_logs` is capped per session (~2000 rows, pruned every 200 inserts) to bound replay overhead.

## Conventions & gotchas

- Formatting is Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before committing.
- `bun:sqlite` uses `$name` named params. Schema changes go through the `migrations` array in `db.ts` (versioned, idempotent) — never edit an applied migration; append a new one.
- Terminal rendering: the mobile client uses a full VT emulator `apps/mobile/src/terminal.ts` (grid + scrollback, cursor addressing / alt-screen / caret). Icons are Feather from `@expo/vector-icons`.
- DB and runtime state live in `~/.tether/config/tether.db` for the installed binary (dev/tests use `TETHER_DB_PATH`, which overrides). An existing pre-binary `~/.tether/app/config/tether.db` migrates automatically on first run. Override port with `TETHER_PORT`.
- **Mobile only:** before writing Expo code, read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ (per `apps/mobile/AGENTS.md`). Expo 57 / RN 0.86 / React 19.

## Security note

The server exposes an **unauthenticated** shell over the network (`0.0.0.0`, `cors origin: '*'`). Anyone who can reach the port gets a shell. Treat it as LAN-only / behind a tunnel unless auth is added.

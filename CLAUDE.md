# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tether is a persistent remote-shell console. A Bun/Hono server spawns real PTY shell processes through detached *holder* processes, streams their output over WebSocket, and logs every byte to SQLite so clients can reconnect and replay missed output. Around that core it also serves git diff/stage/commit, a workspace file tree/viewer, file uploads, and HTML "presentations" (previews pushed from a coding agent to the client).

Clients are a single Expo React Native codebase: iOS/Android app, plus a Tauri desktop app built from the same source via `react-native-web`.

## Monorepo layout (Bun workspaces)

- `apps/server/` — Bun + Hono backend (`tether`), compiled to one binary.
  - Entry/lifecycle: `main.ts` (argv dispatch + control CLI + `holder` subcommand), `serve.ts` (`serve()` — reattach holders + `Bun.serve`), `index.ts` (dev entry), `app.ts` (Hono routes + WS gateway), `paths.ts` / `runtime.ts`, `update.ts` (self-update).
  - PTY: `pty.ts` (session registry, holder spawn/reattach, subscribe/write/resize/kill), `holder.ts` (the detached one-PTY-per-process owner), `procCwd.ts` / `procIdentity.ts` / `liveCwd.ts` (cwd + process tracking), `sessionActivity.ts` (`working`/`waiting`/`idle` inference from output), `sessionTitle.ts` (OSC title + auto-title).
  - Data/auth: `db.ts` (bun:sqlite + versioned migrations), `auth.ts` (argon2 password + tokens).
  - Features: `gitDiff.ts` / `gitOps.ts` / `gitRoot.ts` / `gitWatch.ts`, `workspaceFile.ts`, `upload.ts`, `presentations.ts` / `presentCli.ts`.
- `apps/mobile/` — Expo RN client (`tether-mobile`), also the desktop app.
  - `App.tsx` + `src/useTetherApp.tsx` (app state/session orchestration), `src/TerminalScreen.tsx`, `src/SessionDrawer.tsx`, `src/UtilityBar.tsx`, `src/Dpad.tsx`, `src/ConfigScreen.tsx`.
  - Terminal: `src/terminalEngine.ts` (`@xterm/headless` engine), `src/TerminalView*.tsx` + `src/terminalRendererHtml.ts` + `src/terminalRenderer.generated.ts` (xterm.js inside a WebView), `src/terminalRendererProtocol.ts` (RN ↔ WebView messages), `src/ptyInput.ts` / `src/input.ts` / `src/mouseInput.ts`.
  - Features: `src/DiffView.tsx` + `src/diffModel.ts`, `src/FileTree.tsx` / `src/FileViewer.tsx`, `src/PresentationView*.tsx`, `src/CodeHighlight.tsx`, `src/sessionCache.ts` (LRU tab cache).
  - Desktop-only: `src/desktop*.ts`, `src/TitleBar.tsx`, `src/windowControls.ts`, `src-tauri/` (Rust shell, updater, notifications).
- `docs/` — VitePress site (`architecture.md`, `data-flow.md`, `security.md`, `terminal/`, `superpowers/specs/` design docs).

## Commands

Run from repo root:
- `bun install` — install/link all workspaces
- `bun dev:server` — backend on `:8085` (binds `0.0.0.0`), watch mode
- `bun dev:mobile` — Expo Metro bundler
- `bun lint` — Biome + server typecheck + mobile typecheck
- `bun format` — `biome check --write`
- `bun build:server` / `bun start:server` — compile and run `apps/server/dist/tether`
- `bun docs:dev` / `bun docs:build` — VitePress docs

Per workspace:
- Server tests: `bun --cwd apps/server test` (bun:test — extensive, most `.ts` files have a sibling `.test.ts`)
- Mobile logic tests: `bun --cwd apps/mobile test`; component tests: `bun --cwd apps/mobile run test:ui` (jest + `@testing-library/react-native`)
- Terminal WebView bundle: `bun --cwd apps/mobile run build:terminal-renderer` — **rerun after editing `terminalRendererHtml.ts`**, it regenerates the committed `terminalRenderer.generated.ts`
- iOS device build: `cd apps/mobile && npx expo run:ios --device` (Expo Go doesn't support SDK 57)
- Desktop: `bun --cwd apps/mobile run tauri:dev` / `tauri:build`

**Server as a daemon:** the binary *is* the CLI — `serve` (default, foreground) plus `start | stop | restart | status | logs | set-password | present | update | version`; `holder` is internal. `start` re-execs itself detached; pid + log in `~/.tether/`. Installed to `~/.local/bin/tether` by `install.sh`, updated with `tether update`. Honors `TETHER_PORT` / `TETHER_DB_PATH` / `TETHER_REPO_SLUG`.

## Runtime requirement (important)

The PTY relies on `Bun.spawn(..., { terminal: {...} })` and `proc.terminal`, which landed in **Bun ≥ 1.3.14**. On older Bun `proc.terminal` is `undefined`, the shell inherits stdio, hits EOF, and dies in ~10ms. If sessions exit instantly, check `bun --version` first.

## Data flow (the core loop)

1. Client opens `GET /api/ws?sessionId=&sinceId=&cols=&rows=` (token-authed).
2. `startSession` (`pty.ts`) spawns a detached **holder** process (`tether holder <sock> <cols> <rows> <cwd> <cmd>`) that owns the PTY; the server talks to it over a unix socket in `~/.tether/holders/<id>.sock` with newline-delimited JSON frames (`i`/`r`/`k` down, `o`/`x`/`c` up, base64 payloads).
3. Every output chunk → `addTerminalLog` (SQLite) → broadcast to subscribers, and feeds `sessionActivity`, `sessionTitle`, `liveCwd`.
4. On WS open the server replays `getLogs(sessionId, sinceId)`, then streams live. Clients persist `sinceId` so a reconnect only replays what it missed.
5. Client → server: `{type:'input'|'resize'}`. Server → client: `output | exit | title | activity | diff | reset | ping`.

Because the holder is a separate detached process, **the shell survives both client disconnects and server restarts** — `reattachHolders()` re-adopts live sockets on boot. Killing is explicit (`POST /api/sessions/kill`).

**Mobile multi-terminal model:** sessions are drawer tabs; `GET /api/sessions` is the source of truth. Only the active terminal holds a live WebSocket and emulator; switching detaches background sessions (PTY keeps running) and uses an LRU cache (cap 3) for instant reattach. `terminal_logs` is capped per session (~2000 rows, pruned every 200 inserts).

**Two emulators:** `terminalEngine.ts` (`@xterm/headless`, RN side — owns state, scrollback, selection, links) and xterm.js inside the WebView (rendering + keyboard). Keep them in sync; the WebView owns keyboard focus.

## HTTP API surface (`app.ts`)

`/api/status` + `/api/setup` (TOFU pairing) · `/api/health` · `/api/sessions` (list/start/kill/rename) · `/api/sessions/:id/logs` · `/api/sessions/:id/diff{,/file,/summary}` · `/api/sessions/:id/git/{log,commit,commit/:sha/diff}` · `/api/sessions/:id/git/{stage,unstage,discard,stage-hunk,unstage-hunk}` · `/api/sessions/:id/file` · `/api/sessions/:id/upload` · `/api/presentations` (+ `/control/presentations` for the local CLI, `/preview/:token/*` for serving them).

## Conventions & gotchas

- Formatting is Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before committing.
- `bun:sqlite` uses `$name` named params. Schema changes append a new entry to the `migrations` array in `db.ts` — never edit an applied migration.
- Tests are colocated (`foo.ts` + `foo.test.ts`). New server logic is expected to come with tests; keep pure logic in its own module so it's testable without a PTY.
- Runtime state lives in `~/.tether/` (`config/tether.db`, `holders/`, pid, log). `TETHER_DB_PATH` overrides the DB.
- Icons are Feather from `@expo/vector-icons`.
- **Mobile:** read the versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing Expo code (per `apps/mobile/AGENTS.md`). Expo 57 / RN 0.86 / React 19. Don't bump Expo past 57.0.7 — the pinned `expo-modules-jsi@57.0.3` patch is keyed to it.
- Releases: see the `releasing-tether` skill / `scripts/release.sh`. CI requires green before tagging.

## Security note

All `/api/*` routes (HTTP + WS upgrade) require a shared password — argon2 hash in the DB, set via `tether set-password` or first-run TOFU pairing (`GET /api/status` + one-time `POST /api/setup`), exchanged for a token. No password ⇒ every client is rejected (401). **Transport is still unencrypted** (`0.0.0.0`, `cors origin: '*'`) — run tether behind a tunnel (Tailscale / WireGuard / SSH) or keep it LAN-only. Note the API exposes file read, upload, and git write ops, so the password is the only thing between the port and the machine.

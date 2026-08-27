# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tether is a persistent remote-shell console. A Bun/Hono server spawns real PTY shell processes through detached *holder* processes, streams their output over WebSocket, and logs every byte to SQLite so clients can reconnect and replay missed output. Around that core it also serves git diff/stage/commit, a workspace file tree/viewer, file uploads, and HTML "presentations" (previews pushed from a coding agent to the client).

Clients are native and share one Rust core (`crates/tether-core`):

- **`apps/desktop`** — Linux/Windows/macOS, a Tauri app (vite + xterm.js over the
  core). Keeps the legacy bundle identifier (`cloud.samlo.tether`) on purpose so
  in-place updates inherit the previous app's webview storage and host profiles.
- **`clients/apple`** — iOS, native Swift/SwiftUI over the core through an
  XCFramework (`scripts/build-xcframework.sh`), plus a Notification Service
  Extension (`TetherNotificationService`) that decrypts push payloads on-device.

Android was decommissioned after v2.8.12. The old Expo/RN client (`apps/mobile`)
has been removed from the tree.

`release.yml` builds exactly three things: `apps/desktop`, `clients/apple`, and
the server binaries.

## Monorepo layout (Bun workspaces)

- `apps/server/` — Bun + Hono backend (`tether`), compiled to one binary. **Source lives in `apps/server/src/server/`** — every filename in the bullets below is relative to that directory (so `main.ts` is `apps/server/src/server/main.ts`). Routes are split under `src/server/routes/` (`sessions.ts`, `git.ts`, `presentations.ts`, …). `src/web/dist/` holds the built web assets the binary serves.
  - Entry/lifecycle: `main.ts` (argv dispatch + control CLI + `holder` subcommand), `serve.ts` (`serve()` — reattach holders + the http/https `Bun.serve` listeners), `index.ts` (dev entry), `app.ts` (Hono routes + WS gateway), `paths.ts` / `runtime.ts`, `update.ts` (self-update).
  - PTY: `pty.ts` (session registry, holder spawn/reattach, subscribe/write/resize/kill), `holder.ts` (the detached one-PTY-per-process owner), `procCwd.ts` / `procIdentity.ts` / `liveCwd.ts` (cwd + process tracking), `sessionActivity.ts` (`working`/`waiting`/`idle` inference from output), `sessionTitle.ts` (OSC title + auto-title).
  - Data/auth: `db.ts` (bun:sqlite + versioned migrations), `auth.ts` (argon2 password + tokens), `config.ts` (zod-typed settings over the `settings` table, client-editable).
  - Transport: `x509.ts` (hand-rolled DER + self-signed cert generation, no deps), `tlsStore.ts` (`~/.tether/config/tls/`, generate-once), `tlsConfig.ts` (listener plan from env — pure), `tlsRuntime.ts` (the report the routes read).
  - Features: `gitDiff.ts` / `gitOps.ts` / `gitRoot.ts` / `gitWatch.ts`, `workspaceFile.ts`, `upload.ts`, `presentations.ts` / `presentCli.ts`, `push.ts` / `pushCrypto.ts` / `pushDevices.ts` / `pushRelay.ts` (native APNs push via the relay), `admin.ts` (password/update/restart/test-notification).
- `apps/desktop/` — Tauri 2 desktop client (`tether-desktop`). Vite + React + xterm.js frontend; Rust commands in `src-tauri/` link `tether-core` directly.
- `apps/relay/` — Bun + Hono push relay (`tether-relay`), deployed separately (`Dockerfile` + `docker-compose.yml`). Routes ciphertext it cannot read from a tether server to APNs; see **Push notifications** below. Own tests (`bun --cwd apps/relay run test`).
- `clients/apple/` — native iOS app (`TetherIOS` + `TetherKit` SPM package + `TetherNotificationService`).
- `crates/` — `tether-core`, `tether-proto`, `tether-ffi` (UniFFI → Swift).
- `docs/` — VitePress site (`architecture.md`, `data-flow.md`, `security.md`, `terminal/`, `superpowers/specs/` design docs, `superpowers/plans/` implementation plans).
- `icon.png` — brand mark at repo root (also used by the iOS AppIcon / README).

## Commands

Run from repo root:
- `bun install` — install/link all workspaces
- `bun dev:server` — backend on `:8085` (binds `0.0.0.0`), watch mode
- `bun dev:desktop` — the Tauri desktop client (`apps/desktop`)
- `bun lint` — Biome + server typecheck + desktop typecheck
- `bun format` — `biome check --write`
- `bun build:server` / `bun start:server` — compile and run `apps/server/dist/tether`
- `bun docs:dev` / `bun docs:build` — VitePress docs

Per workspace:
- Desktop tests: `bun --cwd apps/desktop run test`; its Rust half is
  `cd apps/desktop/src-tauri && cargo test` (CI: the `desktop-build` job)
- Server tests: `bun --cwd apps/server run test` (bun:test — extensive, most `.ts` files have a sibling `.test.ts`)
- Use `run test`, not `bun test`: the built-in runner wins over the script name, so bare `bun test` silently drops the `--parallel` flag the scripts carry (12.8s → 3.3s on the server suite). Never pin `TETHER_DB_PATH` for a suite run — `test-preload.ts` gives each process its own temp DB, and one shared file makes parallel workers fight over it.
- iOS: see `clients/apple/README.md` (`scripts/build-xcframework.sh`, then `xcodebuild -project clients/apple/Tether.xcodeproj -scheme TetherIOS …`)
- Desktop: `bun --cwd apps/desktop run tauri:dev` / `tauri:build`

**Server as a daemon:** the binary *is* the CLI — `serve` (default, foreground) plus `start | stop | restart | status | logs | set-password | present | signal | update | version`; `holder` is internal. `start` re-execs itself detached; pid + log in `~/.tether/`. Installed to `~/.local/bin/tether` by `install.sh`, updated with `tether update`. Honors `TETHER_PORT` / `TETHER_TLS` / `TETHER_TLS_PORT` / `TETHER_DB_PATH` / `TETHER_REPO_SLUG`.

## Runtime requirement (important)

The PTY relies on `Bun.spawn(..., { terminal: {...} })` and `proc.terminal`, which landed in **Bun ≥ 1.3.14**. On older Bun `proc.terminal` is `undefined`, the shell inherits stdio, hits EOF, and dies in ~10ms. If sessions exit instantly, check `bun --version` first.

Development and CI run **Bun 1.4.x** (`bun-version: latest`); 1.3.14 stays the floor because that is where the PTY API landed, not because anything newer is required.

## Data flow (the core loop)

1. Client opens `GET /api/ws?sessionId=&sinceId=&cols=&rows=` (token-authed).
2. `startSession` (`pty.ts`) spawns a detached **holder** process (`tether holder <sock> <cols> <rows> <cwd> <cmd>`) that owns the PTY; the server talks to it over a unix socket in `~/.tether/holders/<id>.sock` with newline-delimited JSON frames (`i`/`r`/`k` down, `o`/`x`/`c` up, base64 payloads).
3. Every output chunk → `addTerminalLog` (SQLite) → broadcast to subscribers, and feeds `sessionActivity`, `sessionTitle`, `liveCwd`.
4. On WS open the server replays `getLogs(sessionId, sinceId)`, then streams live. Clients track `sinceId` **in memory only** — it is *not* persisted anywhere, so an LRU eviction, an app restart, or a server-sent `reset` drops it and the next connect replays the whole retained tail. That churn is board task #731.
5. Client → server: `{type:'input'|'resize'|'focus'}`. Server → client: `output | exit | title | activity | diff | reset | ping`.

**Push notifications:** the server encrypts a notification for each registered device and posts it to the relay (`apps/relay`, URL baked in at build time by `pushRelay.ts` — not a user setting) when a session flips to `waiting`, emits an OSC 9/777 notify, exits, or finishes a long job. iOS only; `TetherNotificationService` decrypts on arrival, so the relay never sees plaintext. ntfy was removed in favour of this. A session is suppressed only while an attached subscriber reports `focused: true` — a backgrounded phone keeps its socket, so it still gets pushed. Notification delivery is advisory and never blocks the PTY path.

**Session activity:** `sessionActivity.ts` classifies each session `working` /
`waiting` / `done` / `idle` from the PTY byte stream. `waiting` means BLOCKED —
the only state allowed to pull attention away from the active tab. `done` means
a piece of work finished; its own colour, its own notification trigger, off by
default. A program can override the guesswork with
`tether signal <working|waiting|done>` (`TETHER_SESSION_ID` is exported into
every session; the CLI posts to `/control/signal` with the present-control
token). A session that has signalled is *agent-driven*: the byte heuristics stop
guessing for it and its duplicate OSC push is suppressed, until it reaches a
shell prompt, which releases the latch. `tether signal hooks` prints the Claude
Code configuration mapping its `Notification` hook to `waiting` and its `Stop`
hook to `done`.

Because the holder is a separate detached process, **the shell survives both client disconnects and server restarts** — `reattachHolders()` re-adopts live sockets on boot. Killing is explicit (`POST /api/sessions/kill`).

**Multi-host:** the client holds N host profiles in the Rust core (`host_store`); passwords on iOS live in Keychain, on desktop in the OS keyring under service `tether-desktop`, account `server-password-<hostId>` (falling back to localStorage when no Secret Service is running). The drawer groups sessions by host. Cache and connection keys are `"<hostId>:<sessionId>"` — session ids are only unique per host. Every host is independently failable. `tether://session/<id>?host=<identityName>` deep links resolve a notification tap to the right host.

**Session model:** sessions are drawer tabs; `GET /api/sessions` is the source of truth. Resident sessions keep live sockets and stream in the background — only input and clipboard are gated to the active tab. Evicted sessions drop their socket; the PTY keeps running, and reattaching replays from `sinceId`. `terminal_logs` is capped per session (~2000 rows, pruned every 200 inserts).

**Terminals:** desktop uses xterm.js in the Tauri webview; iOS uses a native CoreText grid fed by `alacritty_terminal` in the core.

## HTTP API surface (`app.ts`)

`/api/status` + `/api/setup` (TOFU pairing) · `/api/health` · `/api/sessions` (list/start/kill/rename) · `/api/sessions/:id/logs` · `/api/sessions/:id/diff{,/file,/summary}` · `/api/sessions/:id/git/{log,commit,commit/:sha/diff}` · `/api/sessions/:id/git/{stage,unstage,discard,stage-hunk,unstage-hunk}` · `/api/sessions/:id/file` · `/api/sessions/:id/upload` · `/api/presentations` (+ `/control/presentations` for the local CLI, `/control/signal` for program-declared session state, `/preview/:token/*` for serving them) · `/api/config` (GET/PATCH; the GET also reports read-only `pushDevices` and `tls`) · `/api/push/{register,unregister}` · `/api/admin/{password,update,restart,test-notification}` (the first three require the current password in the body, on top of the token).

## Conventions & gotchas

- Formatting is Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before committing.
- `bun:sqlite` uses `$name` named params. Schema changes append a new entry to the `migrations` array in `db.ts` — never edit an applied migration.
- Tests are colocated (`foo.ts` + `foo.test.ts`). New server logic is expected to come with tests; keep pure logic in its own module so it's testable without a PTY.
- Runtime state lives in `~/.tether/` (`config/tether.db`, `holders/`, pid, log). `TETHER_DB_PATH` overrides the DB.
- Releases: see the `releasing-tether` skill / `scripts/release.sh`. CI requires green before tagging.

## Security note

All `/api/*` routes (HTTP + WS upgrade) require a shared password — argon2 hash in the DB, set via `tether set-password` or first-run TOFU pairing (`GET /api/status` + one-time `POST /api/setup`), exchanged for a token. No password ⇒ every client is rejected (401).

**Transport:** the server opens two listeners — plaintext on `TETHER_PORT` (8085) and TLS on `TETHER_TLS_PORT` (8443), both `0.0.0.0`, `cors origin: '*'`. A self-signed P-256 certificate is generated on first boot into `~/.tether/config/tls/` (key `0600`, dir `0700`) and **never rotated automatically** — clients pin its fingerprint. `/api/status` and `/api/setup` report `secure` (was *this response* on the TLS socket? derived from the socket, never from a header) plus `tls.fingerprint` (`sha256:<hex>` over the cert DER); a client may only pin what it read with `secure: true`, and must match it against the cert that actually terminated the connection.

`TETHER_TLS` = `both` (default) | `only` (closes plaintext) | `off`. It is host-side env config on purpose and is **not** in `/api/config` — a client that could close the plaintext port would lock out every other client. Default `both` means `tether update` strands nobody; `only` is the operator's deliberate cutover.

Still keep tether behind a tunnel (Tailscale / WireGuard / SSH) or LAN-only: the cert is self-signed (an unpinned first contact is MITM-able), CORS is open, and the API exposes file read, upload, and git write ops. See `docs/security.md`.

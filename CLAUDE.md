# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tether is a persistent remote-shell console. A Bun/Hono server spawns real PTY shells through detached *holder* processes, streams their output over WebSocket, and logs every byte to SQLite so clients can reconnect and replay. Around that it serves git diff/stage/commit, a workspace file tree, uploads, and HTML "presentations" pushed from a coding agent.

**The server is POSIX-only.** Windows server support was removed in `8294d80d` — it cost ~1200 lines of Windows-only code and had no users. Do not reintroduce `process.platform === 'win32'` in `apps/server`. Note the asymmetry: the **desktop client still ships for Windows** and talks to a Linux/macOS server like any other client.

Clients are native and share one Rust core (`crates/tether-core`): **`apps/desktop`** (Tauri 2, vite + xterm.js) and **`clients/apple`** (Swift/SwiftUI over an XCFramework, plus a Notification Service Extension). Android was decommissioned after v2.8.12. `release.yml` builds exactly three things: `apps/desktop`, `clients/apple`, and the server binaries.

## Commands

From repo root:
- `bun install` · `bun lint` (Biome + both typechecks) · `bun format`
- `bun dev:server` — backend on `:8085`, watch mode
- `bun dev:desktop` — Tauri desktop client
- `bun build:server` / `bun start:server` — compile and run `apps/server/dist/tether`
- `bun docs:dev` / `bun docs:build` — VitePress docs

Per workspace: `bun run --cwd apps/server test` · `bun run --cwd apps/desktop test` · `bun run --cwd apps/relay test` · `bun run --cwd apps/desktop tauri:dev`. Desktop's Rust half: `cd apps/desktop/src-tauri && cargo test`. iOS: see `clients/apple/README.md`.

**Three invocation footguns, all of which exit 0 while doing nothing or the wrong thing:**
- Put `run` **before** `--cwd`. `bun run --cwd apps/server test` works; `bun --cwd apps/server run test` prints the script list and exits 0 without running anything (Bun 1.4.0). `bun --cwd apps/server typecheck` — no `run` — is also fine.
- Use `run test`, not bare `bun test`: the built-in runner shadows the script name and silently drops `--parallel` (12.8s → 3.3s on the server suite).
- Never pin `TETHER_DB_PATH` for a suite run — `test-preload.ts` gives each worker its own temp DB; one shared file makes parallel workers fight.

**Server as a daemon:** the binary *is* the CLI — `serve` (default) plus `start | stop | restart | status | logs | pair | present | signal | devices | device | update | version`; `holder` is internal. `start` re-execs detached; pid + log in `~/.tether/`. Installed to `~/.local/bin/tether`, updated with `tether update`. Honors `TETHER_PORT` / `TETHER_TLS` / `TETHER_TLS_PORT` / `TETHER_DB_PATH` / `TETHER_CONTROL_SOCK` / `TETHER_REPO_SLUG`.

## Layout

Bun workspaces. `apps/server/src/` is three entry points plus one folder per domain, nothing deeper than two levels (only generated `proto/gen/` reaches two):

| | |
|---|---|
| `main.ts` `index.ts` `serve.ts` | argv dispatch + control CLI + `holder` subcommand; dev entry; reattach holders + the http/https listeners |
| `pty/` | session registry, the detached holder and its binary frame dialect, shell selection, cwd tracking, activity/title inference, replay |
| `agent/` | agent drivers, registry, message mapping, usage |
| `auth/` | per-device bearer verify, device registry, pairing, enrollment |
| `noise/` `tls/` | Noise IK channel + FFI + session protocol; listener plan, cert store, hand-rolled x509 |
| `git/` `workspace/` | diff/ops/status/root/watch; file read, path resolution, dir listing, upload |
| `push/` | encrypted APNs push via the relay, notification triggers |
| `presentations/` | preview registry, shared instance, CLI |
| `cli/` `control/` | subcommands `main.ts` dispatches; the loopback control socket they talk to |
| `http/` | the Hono app and every route module |
| `infra/` | `db` (bun:sqlite + versioned migrations), `log`, `paths`, `runtime`, `settings` (zod-typed, client-editable), `testEvents` |
| `proto/` `testing/` | wire frame + codec; test-only helpers |

Other workspaces: `apps/desktop/` (Tauri 2; Rust commands in `src-tauri/` link `tether-core`), `apps/relay/` (push relay, deployed separately), `clients/apple/`, `crates/` (`tether-core`, `tether-proto`, `tether-ffi`), `docs/` (VitePress).

## Conventions & gotchas

- **Bun ≥ 1.3.14 is required.** The PTY relies on `Bun.spawn(..., { terminal })` and `proc.terminal`. On older Bun `proc.terminal` is `undefined`, the shell hits EOF and dies in ~10ms. If sessions exit instantly, check `bun --version` first. Dev and CI run 1.4.x.
- **Imports:** cross-domain uses the `@/*` alias (`@/infra/db`); same-folder stays relative (`./diff`). No `baseUrl` in tsconfig — TypeScript 7 removed it.
- **Moving a file is not just its imports.** `import.meta.dir` joins, `require()` strings and `new URL(..., import.meta.url)` are invisible to a `from '…'` rewrite *and* to `tsc`; they fail at runtime, and here that looks like PTY tests timing out at 2s with no message.
- Comments: minimal. Only a non-obvious "why" or a gotcha. Never restate the code.
- Formatting is Biome: 2-space, single quotes, semicolons, trailing commas, **width 120**. Run `bun format` before committing. `noExcessiveLinesPerFile` (400) counts *code* lines — it skips blanks and comments, so a 458-line file can pass.
- `bun:sqlite` uses `$name` params. Schema changes append to the `migrations` array in `infra/db.ts` — never edit an applied migration.
- Tests are colocated (`foo.ts` + `foo.test.ts`). New logic comes with tests; keep pure logic in its own module so it's testable without a PTY.
- Runtime state lives in `~/.tether/` (`config/tether.db`, `holders/`, pid, log, `control.sock`). A source run instead writes `<cwd>/config/` — which is why `.gitignore` matches `apps/server/**/config/`.
- Releases: see the `releasing-tether` skill / `scripts/release.sh`. CI must be green before tagging.

## Data flow (the core loop)

1. Client reconnects Noise IK to `GET /api/noise/session` (the handshake is auth; no bearer on that socket).
2. Over the sealed channel `{t:'start', id, cols, rows, sinceId?}` → `startSession` (`pty/registry.ts`) spawns a detached **holder** that owns the PTY. The server talks to it over a unix socket in `~/.tether/holders/<id>.sock` with length-prefixed binary frames.
3. Every output chunk → `addTerminalLog` (SQLite) → broadcast to subscribers, and feeds activity, title and live-cwd tracking.
4. On start the server replays `getReplayLogs(sessionId, sinceId)` (byte-budgeted; `reset` if the cursor predates a prune), then streams live. Clients hold `sinceId` **in memory only**, so an eviction, restart or `reset` replays the whole retained tail — board task #731.
5. Client → server (sealed JSON): `input` / `resize` / `focus` / `start`. Server → client: `output` / `exit` / `title` / `activity` / `diff` / `reset`. REST uses a bearer minted on the same channel (`{t:'auth.token'}`).
6. `GET /api/ws` still exists as a bearer-authed JSON socket (`proto=1`, optional binary `proto=2`). Shipping clients do not use it.

Because the holder is a separate detached process, **the shell survives both client disconnects and server restarts** — `reattachHolders()` re-adopts live sockets on boot. Killing is explicit (`POST /api/sessions/kill`).

**Sessions** are drawer tabs; `GET /api/sessions` is the source of truth. Resident sessions keep live sockets and stream in the background; only input and clipboard are gated to the active tab. `terminal_logs` is capped per session (~2000 rows, pruned every 200 inserts). Cache and connection keys are `"<hostId>:<sessionId>"` — session ids are only unique per host.

**Multi-host:** the client holds N host profiles in the Rust core (`host_store`). Pairing is per-device Noise (`tether pair`). Key bytes live in Keychain (iOS) or the OS keyring (desktop). Every host is independently failable. `tether://session/<id>?host=<identityName>` deep links resolve a notification tap to the right host.

## Session activity & push

`pty/activity.ts` classifies each session `working` / `waiting` / `done` / `idle` from the PTY byte stream. `waiting` means BLOCKED — the only state allowed to pull attention from the active tab. A program can override the guesswork with `tether signal <state>`; a session that has signalled is *agent-driven* and the heuristics stop guessing for it. See **[docs/terminal/session-signals.md](docs/terminal/session-signals.md)** for the latch semantics and the Claude Code hook wiring.

The server encrypts a notification per registered device and posts it to the relay (`apps/relay`; URL baked in at build time by `push/relay.ts`, not a user setting) when a session flips to `waiting`, emits an OSC 9/777 notify, exits, or finishes a long job. iOS only; the Notification Service Extension decrypts on arrival, so the relay never sees plaintext. A session is suppressed only while an attached subscriber reports `focused: true` — a backgrounded phone keeps its socket and still gets pushed. Delivery is advisory and never blocks the PTY path.

## HTTP API surface (`src/http/`)

`/api/status` · `/api/health` · `/api/sessions` (list/start/kill/rename) · `/api/sessions/:id/logs` · `/api/sessions/:id/diff{,/file,/summary}` · `/api/sessions/:id/git/{log,commit,commit/:sha/diff}` · `/api/sessions/:id/git/{stage,unstage,discard,stage-hunk,unstage-hunk}` · `/api/sessions/:id/file` · `/api/sessions/:id/upload` · `/api/presentations` (+ `/control/presentations`, `/control/signal`, `/control/pair` for the local CLI, `/preview/:token/*` to serve them) · `/api/config` (GET/PATCH; GET also reports read-only `pushDevices` and `tls`) · `/api/push/{register,unregister}` · `/api/admin/{update,restart,test-notification}` · `/api/noise/{pair,session}` · `/api/ws`.

## Security note

All `/api/*` routes (HTTP + WS upgrade) require a per-device bearer minted over an already-authenticated Noise session and sent as `Authorization: Bearer <token>`. Pair with `tether pair`. There is no shared password and no TOFU setup flow. Revoking a device is enough: its next request is 401. Public exceptions are `/api/status` (discovery) and `/api/noise/*` (authenticated by Noise itself).

**Transport:** two listeners — plaintext on `TETHER_PORT` (8085) and TLS on `TETHER_TLS_PORT` (8443), both `0.0.0.0`, `cors origin: '*'`. A self-signed P-256 cert is generated on first boot into `~/.tether/config/tls/` (key `0600`, dir `0700`) and **never rotated automatically** — clients pin its fingerprint. `/api/status` reports `secure` (derived from the socket, never a header) plus `tls.fingerprint`; a client may only pin what it read with `secure: true`.

`TETHER_TLS` = `both` (default) | `only` (closes plaintext) | `off`. Host-side env config on purpose, **not** in `/api/config` — a client that could close the plaintext port would lock out every other client.

Keep tether behind a tunnel (Tailscale / WireGuard / SSH) or LAN-only: the cert is self-signed, CORS is open, and the API exposes file read, upload and git write ops. See `docs/security.md`.

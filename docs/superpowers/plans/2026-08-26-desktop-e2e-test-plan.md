# Desktop e2e test plan

**Goal:** prove every desktop feature works after the redesign, with tests that
run on the macOS build host rather than in my head.

**Status:** plan only. Nothing below is built or run yet.

## Two constraints that shape everything

Both were measured, not assumed.

1. **`macbuild` has no JS toolchain.** `which node bun` → not found. cargo and
   xcodebuild are there. So anything Rust runs today; anything needing vite or
   WebdriverIO needs an install first.
2. **`tauri-driver` does not support macOS** — "macOS has no WKWebView driver
   tool available". The supported path is WebdriverIO with
   `@wdio/tauri-service`, which embeds a WebDriver server *inside the app*.
   That is a different, newer dependency and its macOS support is the single
   biggest unknown in this plan.

Consequence: a real driven-window e2e on the Mac is plausible but unproven.
The plan therefore front-loads a spike on it and does not depend on it for
coverage of the logic.

## Layers

| Layer | What it exercises | Runs on macbuild | Exists |
|---|---|---|---|
| L0 unit | pure TS + pure Rust | yes | 60 TS, 204 Rust |
| L1 core integration | `tether-core` against a live tether server | yes (cargo) | 2 files, partial |
| L2 command integration | the real `#[tauri::command]` fns via `tauri::test::mock_builder`, no window | yes (cargo) | none |
| L3 UI e2e | the built `.app`, driven | needs node + spike | none |
| L4 visual/manual | look of the redesign, native menus, notifications | screenshots | none |

L2 is where most of the value is: it runs the actual command layer — argument
decoding, state, error mapping — against a real server, with no GUI and no new
toolchain. L3 is the only layer that can catch a broken render, so the redesign
specifically needs it.

## Feature inventory

Every feature, with the layer that is meant to cover it. 62 `core_*`/`secure_*`
commands, five screens, plus the native plugin surface.

### Hosts and secrets
- list, save (create), save (edit) — L2
- edit identity separately from connection (`core_hosts_update_identity` / `_update_connection`) — L2
- remove — L2
- test connection: ok, wrong password, unreachable, needs-setup — L2
- TOFU pairing (`/api/setup`, one-shot) — L2
- migration from the legacy JSON profile blob — L2
- duplicate-id repair, and that it clears the ambiguous secret — L1 (has a test)
- keyring get/set/clear, legacy password read + clear — L2, real keyring
- **plaintext fallback when no Secret Service** (board #848) — L2

### Connection and health
- connect, send, close, forget — L2
- health version — L2
- polling start/stop/restart/set-active — L2
- backoff 2s→30s on unreachable; stop entirely on 401; manual retry — L1

### Sessions
- list, start, kill, rename — L2
- next terminal id — L2
- activity inference working/waiting/idle — L1
- OSC title + auto-title — L1
- live cwd — L2
- drawer grouping by host; session strip ordering — L0 (`sessionStrip.test.ts`, new)
- LRU cache touch/delete/ids, eviction at cap — L2

### Terminal
- PTY output stream and input round-trip — L2
- resize — L2
- replay from `sinceId`; server-sent `reset` — L1/L2
- reconnect after a dropped socket replays the tail — L2
- selection, copy, paste, bracketed paste — L3
- OSC 52 clipboard decode — L0
- link detection and open — L0 + L3
- mouse cell + encode — L0
- search addon — L3
- webgl renderer actually initialises (falls back silently otherwise) — L3
- fit on window resize — L3

### Git
- summary, status, diff, diff file, log, commit diff — L2
- stage, unstage, discard — file, hunk, and all — L2
- commit; undo commit; push — L2
- diff parse incl. binary and image diffs — L0
- drawer mode vs review mode — L3

### Workspace
- file tree build — L1
- directory listing, including >2000 entries and the sort-before-slice fix — L2
- file view: text, binary, image `data:` URL — L2 + L3
- upload via picker — L3 (needs a real dialog)
- presentations list, view, close — L2 + L3

### Server settings and admin
- config get/patch — L2
- change password, update, restart, test notification — L2, against a scratch server only
- TLS report and push-device readout render — L3

### Local preferences
- theme light/dark; font size; notification prefs; window state — L0 + L3

### Native
- deep link `tether://session/<id>?host=` resolves to the right host — L1 (parser) + L4
- notification waiting-edge and decide rules — L1
- updater — L4
- clipboard / opener / process / dialog plugins — L4

### Redesign (uncommitted, zero coverage today)
- `litTheme` accent tracking the active session's activity dot — L0 exists, L3 for the visual
- `StatusStrip`, `TerminalToolbar` render and wire their actions — L3
- the 1881-line `index.css` rewrite — L4 screenshots, nothing else can see it

## Execution order

1. **Spike `@wdio/tauri-service` on macOS.** Install node, build the frontend,
   drive the app, assert one thing. If this fails, L3 is out and the redesign's
   visual coverage falls back to L4 screenshots — say so rather than pretend.
2. **Scratch server on the Mac.** `scripts/scratch-server.sh` already does this
   safely; it needs bun on the Mac.
3. **Build L2.** The bulk of the work and the bulk of the coverage.
4. **Fill L1 gaps** the inventory names.
5. **Build L3** if the spike passed, starting with the redesign.
6. **L4 pass** and a written report of what is covered and what is not.

## Prerequisites, and what they cost

Installing on `macbuild`: **bun** (vite build, scratch server) and **node**
(WebdriverIO). Both are user-space installs under `$HOME`. Nothing else on that
machine changes.

## Honesty rules for the report

- A layer that could not run gets reported as "not run", never as "passing".
- Anything covered only by L4 is manual, and manual coverage decays.
- The commands that mutate a real machine — admin update, restart, password
  change, git push, discard — only ever run against a scratch server and a
  throwaway repo.

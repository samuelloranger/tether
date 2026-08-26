# Desktop Parity — `apps/desktop` to the Full RN Feature Line — Design

**Date:** 2026-08-26
**Status:** Approved. Input to the implementation plan.
**Parent spec:** `2026-08-25-native-client-rewrite-design.md` (P3 → P5, desktop half)
**Related:** `2026-08-25-p2-port-inventory.md`, board task #791

## Problem

`apps/desktop` exists and works: Vite + React + xterm.js on Tauri 2, ~2.7k lines,
E2E-verified against a live server (board #791). It covers hosts, TOFU pairing, keyring
credentials, the session drawer, the terminal, and a minimal settings screen.

It is not yet the shipping desktop client, because the react-native-web client in
`apps/mobile` still does more: git drawer and review, file tree and viewer,
presentations, upload, full server settings, themes, notifications, the updater,
session modals, deep links, and terminal selection/links/mouse reporting.

This design covers closing that gap and deleting the react-native-web desktop path in
one cutover.

## Two things stated plainly up front

**1. `apps/desktop` duplicates `tether-core` in TypeScript.** `hostStore.ts`,
`hostClient.ts`, `hostHealth.ts`, `hostPolling.ts` exist as TypeScript in
`apps/desktop/src` *and* as Rust in `crates/tether-core/src`. The Tauri backend
(`apps/desktop/src-tauri/src/main.rs`, 161 lines) exposes only
`core_connect / core_send / core_close / core_forget` plus the keyring commands, so
P2's Rust ports — `host_store`, `host_client`, `host_health`, `host_polling`,
`session_polling`, `terminal_session_logic`, `session_cache`, `tether_app_actions` —
currently ship in no shell at all. The first sprint is therefore not a feature; it is
collapsing that duplication.

**2. "Native performance" here does not mean a native renderer.** The parent spec fixes
desktop as a WebView app with xterm.js as the sole emulator (its risk #4, accepted).
The performance this buys comes from protocol v2's raw PTY bytes (no JSON escaping, no
`JSON.parse` per frame) and from connection, replay, and inference work running in Rust
off the JS thread — not from replacing the renderer. A macOS SwiftUI target reusing
`TetherKit` remains the escape hatch if the WebView terminal proves insufficient on Mac.

## UI direction

Unchanged from the amendment recorded on board #791:

> **Same information architecture, native interactions.** Keep the concepts, names, and
> navigation so nothing is relearned. Rebuild interactions natively. Drop affordances
> that exist only to work around react-native-web — they are inherited debt, not parity.

Concretely, these are **not** ported and have no successor:

| Module | Lines | Why it dies |
|---|---|---|
| `desktopKeys.ts` (+ test) | 269 (+305) | Synthetic key path for RN-web. The webview delivers real `keydown`. |
| `TitleBar.tsx` | 358 | Custom chrome because RN-web could not use the platform titlebar. |
| `windowControls.ts` | — | Same reason. |
| `desktopFocusGuard.ts` (+ test) | 60 (+…) | Works around RN-web focus loss. |
| `desktopLayout.ts`, `desktopNavigation.ts` | 31, 16 | Trivial; re-expressed natively. |
| `desktopNotify.ts`, `desktopUpdate.ts` | 43, 89 | Replaced by `tauri-plugin-notification` / `tauri-plugin-updater` called directly. |

## Core ↔ shell boundary

The parent spec's rule holds: **all decision logic lives in the core; the shell renders
and handles input.** Applied to the parity surface:

### Rust — `crates/tether-core`, reached over Tauri commands and events

- host profiles and migration, auth, TOFU pairing, health backoff, host polling
- session list / start / kill / rename; activity and title inference
- replay cursor, resident-session LRU, one live socket per resident session
- diff model (unified and side-by-side hunks), git status parsing, git review model
- file-tree model; link and path detection
- notification trigger rules
- PTY escape-sequence tables (key → bytes, mouse → bytes, control sequences)

Every one of these has a zero-value-import TypeScript original, so the ports are
mechanical and their existing tests translate:

| TS module | Lines | Value imports | Has test | Rust destination |
|---|---|---|---|---|
| `diffModel.ts` | 206 | 0 | yes | `tether_core::diff_model` |
| `gitStatusModel.ts` | 61 | 0 | yes | `tether_core::git_status` |
| `gitReviewModel.ts` | 58 | 0 | yes | `tether_core::git_review` |
| `gitDrawerLayout.ts` | 33 | 0 | yes | `tether_core::git_review` |
| `links.ts` | 184 | 0 | — | `tether_core::links` |
| `terminalControls.ts` | 195 | 0 | — | `tether_core::pty_input` |
| `input.ts` / `ptyInput.ts` | 76 / 9 | 0 | — | `tether_core::pty_input` |
| `mouseInput.ts` / `mouseSeq.ts` | 59 / — | 1 | — | `tether_core::pty_input` |
| `appTheme.ts` | 274 | 1 | — | stays TS — it is a style table, not logic |

### TypeScript / React — `apps/desktop/src`

- xterm.js rendering, keyboard and mouse input, the WebView terminal
- layout, panes, drawers, and every component
- Tauri plugin glue: notification, updater, clipboard-manager, dialog, deep-link,
  window-state, opener
- theme tables and CSS

### Command surface

The Tauri backend grows from 4 core commands to a full one. Naming stays `core_*`, and
every command is a thin wrapper — no logic in `main.rs`. Structural changes continue to
arrive as Tauri events, not as polling from the frontend.

## Sprints

Six units. **A must land alone and first** — it touches working code. **B, C, D, and E
are independent of each other** once A is in, and are meant to run as concurrent agents
on separate branches. **F is last.**

### A — Core collapse

No new user-facing behavior. Delete `apps/desktop/src/{hostStore,hostClient,hostHealth,hostPolling}.ts`
and route the frontend through Tauri commands over
`tether_core::{host_store, host_client, host_health, host_polling, session_polling,
terminal_session_logic, session_cache}`. Keep `secureConfig.ts` — the keyring is
shell-owned by design.

Acceptance: the #791 E2E path still passes — host add/edit/switch with TOFU, credentials
in the OS keyring, drawer grouped by host with activity dots, rename, kill, new session,
host health, live title/activity frames, terminal streaming with replay, and no stray
Device Attributes injected at the prompt.

### B — Terminal completeness

Selection and copy, clickable links (`tether_core::links` + the opener plugin), mouse
reporting, OSC 52 clipboard, the scrollbar, in-terminal search, font and theme
selection, and **multi-session live sockets with the LRU** — every resident session
keeps its own socket and streams in the background; only input and clipboard are gated
to the active tab. Cap 3, matching `sessionCache.ts`.

### C — Git

Drawer: status, stage, unstage, discard, stage-hunk, unstage-hunk. Review: side-by-side
diff, image diffs, syntax highlighting. Commit box. Log and history, including
`git/commit/:sha/diff`. Undo and push.

Endpoints: `/api/sessions/:id/diff{,/file,/summary}`,
`/api/sessions/:id/git/{log,commit,commit/:sha/diff}`,
`/api/sessions/:id/git/{stage,unstage,discard,stage-hunk,unstage-hunk}`.

RN reference: `GitDrawer.tsx`, `GitReview.tsx`, `CommitBox.tsx`, `DiffLines.tsx`,
`gitDrawerPanes.tsx`, `gitReviewFileBlock.tsx`, `gitReviewChanges.tsx`,
`GitSectionHeader.tsx`, `GitTabBar.tsx`, `useGitCommitForm.ts`, `useGitDrawerLayout.ts`.

### D — Workspace

File tree, file viewer with syntax highlighting, upload, presentations.

Upload goes through **Tauri's file-drop event**, not HTML5 drag-and-drop.
Presentations navigate the webview to `/preview/:token/*`, which needs a CSP allowance
in `tauri.conf.json` — verify before building the UI.

Endpoints: `/api/sessions/:id/file`, `/api/sessions/:id/upload`, `/api/presentations`.

RN reference: `FileTree.tsx`, `FileViewer.tsx`, `CodeHighlight.tsx`,
`PresentationView*.tsx`, `PresentationBanner.tsx`.

### E — Settings and shell

Full server settings over `/api/config` (GET/PATCH) and `/api/admin/{password,update,restart,test-notification}`
— `push.enabled`, `triggers.{waiting,oscNotify,exit,longJob}`, `longJobSeconds`,
`identity.{name,color}`, `session.{defaultShell,defaultCwd,scrollbackRows,silenceMs}`.
Note the trap fixed in `46c1c78`: only apply the identity rename when the patch
actually contained `identity`.

Also: Catppuccin theme set, sidebar pin and layout, session modals (rename, kill
confirm), overflow menu, alert modal, `tether://session/<id>?host=<identityName>` deep
links, desktop notifications, and the Tauri updater.

RN reference: `ServerSettings.tsx`, `ServerSettingsSections.tsx`,
`ServerSettingsWidgets.tsx`, `useServerSettings.ts`, `serverSettingsActions.ts`,
`SessionModals.tsx`, `OverflowMenu.tsx`, `appTheme.ts`.

### F — Cutover

Point the shipping desktop build at `apps/desktop`. Delete `apps/mobile/src/desktop*.ts`,
`TitleBar.tsx`, `windowControls.ts`, the react-native-web shim, and the
`react-native-web` dependency. Update `scripts/release.sh`, the Release workflow, and
the docs. `apps/mobile` keeps building the iOS/Android app and is not deleted here —
that is P5's call, once the Swift client also reaches parity.

## Testing

- **Rust:** unit tests in `tether-core` for every ported module, translated from the
  existing TypeScript tests (`diffModel.test.ts`, `gitStatusModel.test.ts`,
  `gitReviewModel.test.ts`, `gitDrawerLayout.test.ts`, `useGitCommitForm.test.ts`).
  `cargo test -p tether-core`.
- **TypeScript:** `bun --cwd apps/desktop run test` for the shell logic that stays in TS.
- **Lint:** `bun lint` — Biome plus all three typechecks.
- **E2E:** manual, against the dev server on display `:1`, per sprint.

## Risks

1. **Sprint A regresses a working client.** It rewrites the wiring that #791 spent a
   debugging cycle stabilising, including the replay-cursor bug that rendered the
   terminal blank. Mitigation: A lands alone, and its acceptance is the #791 E2E path
   re-run, not a diff review.
2. **Presentations under Tauri's CSP.** Navigating to `/preview/:token/*` may be blocked.
   Verify the CSP first; the fallback is an iframe with an explicit `connect-src`.
3. **Drag-and-drop upload.** Tauri intercepts file drops at the window level; the HTML5
   DnD events RN-web used will not fire.
4. **Five branches on one repo.** B/C/D/E each get their own branch off A; F merges.
   Shared surfaces — `index.css`, `App.tsx`, `useTetherDesktop.tsx` — will conflict.
   Each sprint must confine itself to new files plus narrow, additive edits at those
   three seams.
5. **Dual maintenance until F.** Every desktop bug is fixed twice until the cutover.
   This is the known cost of the rewrite and is why F is scoped tightly.

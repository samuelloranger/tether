# Desktop frontend reorganization

**Date:** 2026-09-11
**Scope:** `apps/desktop/src`, `apps/desktop/src-tauri/src`, `apps/desktop/tsconfig.json`, `apps/desktop/vite.config.ts`, new `apps/desktop/CLAUDE.md`
**Status:** approved, ready for implementation plan

Follows `docs/superpowers/specs/2026-09-11-server-reorg-design.md`, which did the
same exercise for `apps/server`. Where the two differ, this document says so —
the differences are the interesting part.

## Problem

`apps/desktop/src` holds 142 flat entries: 100 source files and 42 tests, 12.1k
lines. Two domain folders already exist — `agent/` (29 files) and `git/` (16) —
and they are good: components, hooks and logic colocated per feature. They have
simply never been extended to the rest of the tree.

`App.tsx` is 741 lines, of which `App()` itself is ~620 with 16 hooks. It is not
addressed here (see **Out of scope**).

## Decisions

| Decision | Choice | Same as server? |
|---|---|---|
| Grouping | By domain, extending `agent/` and `git/` | yes |
| Filenames | **Keep** the domain prefix | **no — server dropped it** |
| Cross-domain imports | `@/*` alias | yes |
| Alias wiring | tsconfig `paths` **and** vite `resolve.alias` | **no — bun needed only tsconfig** |
| Rust side | group `noise_*` only; leave `commands/` | n/a |
| Delivery | one PR, ~13 commits | yes |

### Why filenames keep their prefix

The server dropped it (`gitDiff.ts` → `git/diff.ts`). Here the opposite is
right, for two reasons.

The existing folders already keep it: `agent/` on **21 of 21** non-test files,
`git/` on 9 of 14. Extending a convention means following it, not contradicting
it in the same tree.

And React ties a component's filename to its export. `TerminalPane.tsx` exports
`TerminalPane` and is used as `<TerminalPane>`; renaming it to `terminal/Pane.tsx`
desyncs the three. Dropping the prefix only on `.ts` logic files would be a third
convention, matching neither the server nor `agent/`.

The practical payoff: this reorg is a **pure path change**. No file is renamed, so
every symbol, grep, editor bookmark and doc reference still resolves, and the
diff is `git mv` plus import specifiers.

## Target tree

```
apps/desktop/src/
  App.tsx  main.tsx  index.css  vite-env.d.ts

  terminal/       16 + 8    xterm binding, clipboard, links, mouse, OSC, search,
                            fit, frame handling, outbound gating, replay gate, paste
  session/        19 + 13   drawer, tab bar, modals, icons, key/label/list/lru/
                            resume/strip, residency, activity + lit state, tab drag
  pane/           11 + 6    tiling tree, serialization, layout rects, drop zones,
                            pane pickers, split preview
  host/           12 + 8    host + device + pairing screens, address parsing,
                            pairing code, noise host store and token, fingerprints
  platform/       11 + 2    titlebar, window controls, deep links, notifications,
                            updater, theme, native dialog
  workspace/       9 + 2    file tree, viewer, highlighting, workspace api + types
  settings/        7 + 2    settings screens, server settings model, preferences
  shell/           5 + 0    the top-level app hook, overflow menus, alert modal
  core/            4 + 1    Tauri invoke surface, transport, error decoding, shared types
  presentations/   2 + 0    preview view + hook

  agent/  git/              unchanged
```

Four files stay at the root: `App.tsx`, `main.tsx`, `index.css`, `vite-env.d.ts`.
`main.tsx` imports `./index.css`, so the two stay together.

Max depth is 1 level below `src/`.

## File map

Every file below is relative to `apps/desktop/src/`. Paths only — **no file is
renamed**.

### `terminal/` — 16 source, 8 test

Source: `TerminalEmpty.tsx`, `TerminalPane.tsx`, `TerminalToolbar.tsx`, `fitTerminal.ts`, `frameHandler.ts`, `pasteBus.ts`, `pastePayload.ts`, `ptyOutbound.ts`, `replayGate.ts`, `resizeFrame.ts`, `terminalBind.ts`, `terminalClipboard.ts`, `terminalLinks.ts`, `terminalMouse.ts`, `terminalOsc.ts`, `terminalSearch.tsx`

Tests: `fitTerminal.test.ts`, `frameHandler.test.ts`, `pastePayload.test.ts`, `ptyOutbound.test.ts`, `replayGate.test.ts`, `resizeFrame.test.ts`, `terminalLinks.test.ts`, `terminalMouse.test.ts`

### `session/` — 19 source, 13 test

Source: `ResidentTerminals.tsx`, `SessionDrawer.tsx`, `SessionModals.tsx`, `SessionTabBar.tsx`, `TabContextMenu.tsx`, `activity.ts`, `killConfirmCopy.ts`, `litTheme.ts`, `residencyReconcile.ts`, `residentKeys.ts`, `residentSessions.ts`, `sessionIcons.tsx`, `sessionKey.ts`, `sessionLabel.ts`, `sessionList.ts`, `sessionLru.ts`, `sessionResume.ts`, `sessionStrip.ts`, `useTabDrag.ts`

Tests: `activity.test.ts`, `killConfirmCopy.test.ts`, `litTheme.test.ts`, `residencyReconcile.test.ts`, `residentKeys.test.ts`, `residentSessions.test.ts`, `sessionKey.test.ts`, `sessionLabel.test.ts`, `sessionList.test.ts`, `sessionLru.test.ts`, `sessionResume.test.ts`, `sessionStrip.test.ts`, `useTabDrag.test.ts`

### `pane/` — 11 source, 6 test

Source: `EmptyPanePicker.tsx`, `PaneControls.tsx`, `PaneDivider.tsx`, `PanePickerModal.tsx`, `SplitPreviewOverlay.tsx`, `dropZone.ts`, `layoutRects.ts`, `paneTree.ts`, `paneTreeSerialize.ts`, `viewModel.ts`, `viewsSerialize.ts`

Tests: `dropZone.test.ts`, `layoutRects.test.ts`, `paneTree.test.ts`, `paneTreeSerialize.test.ts`, `viewModel.test.ts`, `viewsSerialize.test.ts`

### `host/` — 12 source, 8 test

Source: `DevicesScreen.tsx`, `HostsScreen.tsx`, `PairDeviceScreen.tsx`, `address.ts`, `devicesText.ts`, `groupFingerprint.ts`, `hostRecovery.ts`, `hostScheme.ts`, `noiseHosts.ts`, `noiseToken.ts`, `pairAddress.ts`, `pairingCode.ts`

Tests: `devicesText.test.ts`, `groupFingerprint.test.ts`, `hostRecovery.test.ts`, `hostScheme.test.ts`, `noiseHosts.test.ts`, `noiseToken.test.ts`, `pairAddress.test.ts`, `pairingCode.test.ts`

### `workspace/` — 9 source, 2 test

Source: `CodeHighlight.tsx`, `FileTree.tsx`, `FileViewer.tsx`, `fileOpenBus.ts`, `useWorkspace.tsx`, `useWorkspaceFiles.ts`, `workspaceApi.ts`, `workspaceDirLogic.ts`, `workspaceTypes.ts`

Tests: `workspaceDirLogic.test.ts`, `workspaceTypes.test.ts`

### `settings/` — 7 source, 2 test

Source: `ServerSettingsScreen.tsx`, `SettingsScreen.tsx`, `preferences.ts`, `serverConfig.ts`, `serverSettingsActions.ts`, `serverSettingsModel.ts`, `useServerSettings.ts`

Tests: `preferences.test.ts`, `serverSettingsModel.test.ts`

### `platform/` — 11 source, 2 test

Source: `TitleBar.tsx`, `desktopNavigation.ts`, `desktopNotifications.ts`, `desktopUpdater.ts`, `dialog.ts`, `platform.ts`, `titlebarChrome.ts`, `useDeepLinks.ts`, `useLaunchUpdateCheck.ts`, `useWindowTheme.ts`, `windowControls.ts`

Tests: `dialog.test.ts`, `titlebarChrome.test.ts`

### `core/` — 4 source, 1 test

Source: `coreApi.ts`, `coreTransport.ts`, `invokeError.ts`, `types.ts`

Tests: `invokeError.test.ts`

### `shell/` — 5 source, 0 test

Source: `AlertModal.tsx`, `AppOverflowMenu.tsx`, `OverflowMenu.tsx`, `useHeatArrival.ts`, `useTetherDesktop.tsx`

Tests: _none_

### `presentations/` — 2 source, 0 test

Source: `PresentationView.tsx`, `usePresentations.ts`

Tests: _none_

### Root (unchanged)

`App.tsx`, `main.tsx`, `index.css`, `vite-env.d.ts`.

### `agent/` and `git/` (unchanged)

Neither folder is touched. They are the pattern this reorg extends.

**Totals: 100 source files (96 moved, 4 stay at root), 42 tests.** Verified
programmatically: every flat non-test file is assigned exactly once, with no
duplicates, no omissions and no phantom entries.

## Import alias — and the trap

Add to `apps/desktop/tsconfig.json`:

```json
"paths": { "@/*": ["./src/*"] }
```

No `baseUrl` — TypeScript 7 removed it (`TS5102`).

**This is not sufficient on its own.** The server got away with tsconfig alone
because Bun reads tsconfig `paths` natively. Vite does not. Without a matching
`resolve.alias`, `tsc --noEmit` passes clean while `vite build` and `tauri dev`
fail to resolve every `@/` import.

That is the dangerous shape: the typecheck lies. So `vite.config.ts` also gets:

```ts
import path from 'node:path';
// …
resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
```

and the implementation plan gates every task on a real `vite build`, not just
`tsc`. One task adds both and proves them together before anything moves.

Same convention as the server otherwise: cross-domain uses `@/domain/module`,
same-folder stays relative.

## Rewrite differences from the server

1. **`*.tsx` must be matched.** Over half these files are `.tsx`. The server's
   helpers globbed `*.ts` only; here every `find` needs `\( -name '*.ts' -o -name '*.tsx' \)`.
2. **One dynamic import**: `useTetherDesktop.tsx:443` does
   `await import('./desktopNotifications')`, and that target moves to
   `platform/`. The server plan's generalized helper — which covers `from '…'`,
   `import('…')` and `require('…')` in one pass — handles it.
3. **No `import.meta.dir` anywhere in this workspace.** The trap that silently
   broke every holder spawn in the server reorg does not exist here; the only
   non-relative resolution is the CSS import in `main.tsx`, which does not move.
4. **Asset imports:** `TerminalPane.tsx` imports `@xterm/xterm/css/xterm.css` (a
   package path, unaffected) and `main.tsx` imports `./index.css` (both stay at
   root). No other CSS or asset imports exist.

## Rust side

```
apps/desktop/src-tauri/src/
  main.rs  state.rs  storage.rs  http.rs
  noise/
    mod.rs  session.rs  store.rs  token.rs  ws.rs
  commands/   (unchanged: config, connect, git, hosts, noise, polling,
               sessions, terminal, workspace, mod)
```

`noise_session.rs`, `noise_store.rs`, `noise_token.rs` and `noise_ws.rs` are the
only real cluster among the eight root files. They become `noise/{session,store,token,ws}.rs`
with a new `noise/mod.rs`, and `main.rs` swaps four `mod noise_*;` declarations
for one `mod noise;`. Every `crate::noise_session::` path becomes
`crate::noise::session::`.

`commands/` is left alone deliberately: it is the Tauri IPC boundary — a layer,
not a domain — and splitting it by domain would blur that. `commands/noise.rs` is
1217 lines and a reasonable split candidate, but splitting it is a code change,
not a move, so it is out of scope here.

Gate: `cargo test` **and** `cargo clippy -- -D warnings`, both of which CI runs
(`ci.yml`, the `desktop-build` job).

## `apps/desktop/CLAUDE.md`

The root `CLAUDE.md` now describes the server layout in detail and the desktop in
a single line. A workspace file gives the desktop its own map and is loaded only
when working there. It covers: the domain tree above, the `@/*` convention **and
the vite/tsconfig double-wiring**, the commands (`bun run --cwd apps/desktop test`,
`tauri:dev`, `cargo test` in `src-tauri`), and the gotchas worth carrying —
native drag-drop swallowing in-webview HTML5 DnD on Windows, and the fact that
the desktop client ships for Windows while the server does not.

## Commit sequence

One branch, one PR:

1. `build(desktop): @/* alias in tsconfig and vite` — both, proven together
2-11. one commit per domain folder, in dependency order: `core`, `platform`,
   `terminal`, `session`, `pane`, `host`, `workspace`, `settings`,
   `presentations`, `shell`
12. `refactor(desktop): group the noise modules in src-tauri`
13. `docs(desktop): workspace CLAUDE.md`

Each domain commit leaves the tree green: `tsc --noEmit`, `bun run --cwd apps/desktop test`
(279 tests), `bun lint`, and a real `vite build`.

## Verification

Per commit: **`bun run --cwd apps/desktop build`** · `bun lint` · 279 desktop tests.

That one script is `tsc --noEmit && vite build`, so it closes the alias trap by
construction — it cannot pass with tsconfig wired and vite not. Use it, not a
bare `typecheck`, as the per-commit gate.

Once at the end:
- `bun run --cwd apps/desktop tauri:build` (or `tauri:dev` smoke) — proves the
  alias through the real Tauri pipeline, not just vite
- `cargo test` + `cargo clippy -- -D warnings` in `src-tauri`
- every relative and `@/` import resolved programmatically, expecting zero
  unresolved — the check that caught six broken `./proto/frame` imports in the
  server reorg
- `grep` for stale `src/<basename>` references outside `src/`

## Out of scope

- **Splitting `App.tsx`.** 741 lines, ~620 of them inside `App()` with 16 hooks.
  A real code change that can introduce bugs, so it gets its own PR after this
  one — a revert there should not unwind 96 file moves.
- **Splitting `commands/noise.rs`** (1217 lines). Same reasoning.
- **The `cargo test` flake in `crates/tether-core`** — test binaries each spawn a
  server and collide on a port. Pre-existing, unrelated to this refactor, its own
  PR.
- `apps/server`, `apps/relay`, `clients/apple`, `crates/`.

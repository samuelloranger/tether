# CLAUDE.md — apps/desktop

Tauri 2 desktop client (`tether-desktop`). Vite + React + xterm.js frontend;
Rust commands in `src-tauri/` link `tether-core` directly. Ships for Linux,
Windows and macOS, and talks to a POSIX-only server like any other client.

Keeps the legacy bundle identifier `cloud.samlo.tether` on purpose, so in-place
updates inherit the previous app's webview storage and host profiles.

## Commands

- `bun run --cwd apps/desktop build` — `tsc --noEmit && vite build`. **This is
  the gate**, not `typecheck`: see the alias note below.
- `bun run --cwd apps/desktop test` — 313 tests, `bun:test`, colocated.
- `bun run --cwd apps/desktop tauri:dev` / `tauri:build`
- `cd apps/desktop/src-tauri && cargo test` — CI also runs
  `cargo fmt --check && cargo clippy -- -D warnings`, so a clippy warning is a
  hard failure.

Put `run` **before** `--cwd`. `bun --cwd apps/desktop run test` prints the script
list and exits 0 without running anything (Bun 1.4.0).

## Layout

`src/` is four entry files plus one folder per domain, nothing deeper than one
level:

| | |
|---|---|
| `App.tsx` `main.tsx` `index.css` `vite-env.d.ts` | root; `App.tsx` is a ~110-line composition root that wires hooks to `shell/MainScreen`; `main.tsx` imports `./index.css`, so they stay together |
| `terminal/` | xterm binding, clipboard, links, mouse, OSC, search, fit, frame handling, outbound gating, replay gate, paste |
| `session/` | drawer, tab bar, modals, icons, key/label/list/lru/resume/strip, residency, activity + lit state, tab drag |
| `pane/` | tiling tree and serialization, layout rects, drop zones, pane pickers, split preview |
| `host/` | host/device/pairing screens, address parsing, pairing code, noise host store and token, fingerprints |
| `platform/` | titlebar, window controls, deep links, notifications, updater, theme, native dialog |
| `workspace/` | file tree, viewer, highlighting, workspace API and types |
| `settings/` | settings screens, server-settings model, preferences |
| `agent/` `git/` | agent chat and the git drawer — the folders this layout was extended from |
| `shell/` | the top-level `useTetherDesktop` hook, `MainScreen`, `appScreen`, `useAppChrome`, overflow menus, alert modal, the golden-render test kit |
| `core/` | Tauri invoke surface, transport, error decoding, shared types |
| `presentations/` | preview view and hook |

`src-tauri/src/` is `main.rs`, `state.rs`, `storage.rs`, `http.rs`, plus
`noise/` (session, store, token, ws) and `commands/` — the Tauri IPC boundary,
deliberately left as a layer rather than split by domain.

## Conventions & gotchas

- **Imports:** cross-domain uses `@/domain/module`; same-folder stays relative.
  Filenames keep their domain prefix (`terminal/terminalBind.ts`), so a component
  file still matches its export — `TerminalPane.tsx` exports `TerminalPane`.
- **The alias is wired twice, and only one half is honest.** `tsconfig.json` has
  `paths` (no `baseUrl` — TypeScript 7 removed it), and `vite.config.ts` reads
  that same file through `vite-tsconfig-paths`. Vite does **not** read tsconfig
  `paths` on its own, so without the plugin `tsc --noEmit` exits 0 while
  `vite build` fails on every `@/` import. Never gate on `typecheck` alone.
- **Do not add a `resolve.alias`.** It would duplicate the mapping in a second
  file that can drift. The plugin exists so there is one definition.
- Formatting is Biome, width 120, run from the repo root (`bun format`).
  Rewriting imports reorders them under `organizeImports`, which is an error,
  not a warning.
- Tests are colocated (`foo.ts` + `foo.test.ts`) and run under bun, not vite —
  bun resolves tsconfig `paths` natively.
- **Golden render snapshots.** `src/App.golden.test.tsx` renders the whole `App`
  across 16 states with `renderToString` and snapshots the HTML. It needs no DOM
  library: `renderToString` runs no effects, so xterm never initializes and no
  Tauri `invoke` is reached. `src/shell/appRender.testkit.tsx` supplies the
  `window`/`localStorage` stubs and a `TetherDesktop` mock factory; it is named
  `.testkit.tsx` so the runner does not collect it as a test.
  `crypto.randomUUID` is stubbed with a counter because pane ids reach the DOM as
  `data-pane-id` — with the real implementation every snapshot differs. If a
  golden fails after a refactor, that is the signal working. Read the diff; do
  not regenerate the snapshot to make it pass.
- **Native drag-drop swallows in-webview HTML5 DnD on Windows.** The Tauri
  drag-drop handler is kept for file upload, so in-app dragging must use pointer
  events instead.
- Sanitize the environment before spawning programs from the app: an AppImage
  inherits loader vars that break child processes.

## Out of scope, tracked separately

`src-tauri/src/commands/noise.rs` is 1217 lines — a split candidate, and a code
change rather than a move, so it gets its own PR.

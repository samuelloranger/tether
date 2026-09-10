# Changelog

Newest first. Full notes on each [GitHub release](https://github.com/samuelloranger/tether/releases). Patch releases between the versions below are folded into the nearest feature heading; the GitHub tag has the exact list.

## v4.0 — Noise pairing

- **Per-device Noise authentication** replaces the shared server password. Pair once with `tether pair` (12-char code + host confirmation); the device reconnects on its own key. Existing hosts must be re-paired after the upgrade — see [3.x → 4.0 cutover](/updating#_3-x-4-0-cutover).
- **End-to-end encryption** of the terminal stream (Noise IK reconnect). REST uses a short-lived bearer minted over that channel.
- **Device management** — `tether devices` / `tether device revoke|rename|token`, plus a devices list in the apps.
- **Terminal groups (desktop)** — a split creates a group tab; an ungrouped terminal still runs full-space.
- 4.0.1–4.0.10 are replay, focus, split, and iOS session-switch fixes on top of that cutover.

## v3.3 — desktop split view

- Tile multiple live terminals in one window (hover split, drag a tab onto a pane, right-click a tab). Layout persists.

## v3.2 — Windows server

- The server runs natively on Windows (ConPTY). *(Windows server support was removed in a later release.)*
- iOS: the session drawer stays usable while the terminal is streaming.

## v3.1 — agent `done` vs `waiting`

- A finished agent turn (`done`) is distinct from a session that is blocked on you (`waiting`). `tether signal` lets a program declare the state; `tether signal hooks` prints the Claude Code snippet.
- Expo/RN client (`apps/mobile`) removed from the tree.

## v3.0 — native clients

- **Desktop** ships as `apps/desktop` (Tauri + xterm.js over a shared Rust core).
- **iOS** ships as `clients/apple` (SwiftUI + the same core via UniFFI). iPad layout (pinnable sidebar, hardware keyboard) lands here.
- The Expo release path is retired. Android stays discontinued after v2.8.12.

## v2.8 — TestFlight & native push

- Public [TestFlight](https://testflight.apple.com/join/j7rPkfhq) builds, signed in CI.
- Native iOS notifications via an encrypted relay the operator cannot read. Sideloading dropped — Apple only issues push entitlements to signed apps.
- Privacy policy published.

## v2.7 — default themes

- Default dark/light themes and bezel chrome (Catppuccin flavours remain).

## v2.0 — terminal engine

- Parser swapped to `@xterm/headless`, so escape handling, scrollback, and modes match a real xterm. OSC 8 hyperlinks, inverse video, caret visibility, and the rest of the VT surface ride the new engine.

## v1.16 — mouse click & drag

- **Mouse reporting** — tap/click and drag now reach the PTY, so vim mouse mode, tmux pane clicks, and htop/mc work on phone and desktop. Mobile: tap = click, one-finger drag = drag-select, two-finger drag = wheel scroll. Desktop: real mouse, with **Shift** held to bypass reporting for native text selection.
- **Mouse control toggle** (`⋯` menu) to disable forwarding on demand — falls back to native scroll/tap; the choice persists.

## v1.15 — auto-titles & git diff v2

- **Session auto-titles** — tabs name themselves from OSC 0/2 title sequences, the shell's cwd, and the running command, so you can tell terminals apart at a glance.
- **Git diff view v2** — staging, commits, history, and a side-by-side view; image diffs, a syntax-highlighted gutter, and a grouped file list.
- Patch work: link/URL detection fixes (trailing punctuation, wrapped `selfh.st` links, dead clicks from AppImage env leakage), Prism syntax highlighting across code views, word-delete on hold-backspace (mobile) and Alt/Ctrl+Backspace (desktop), macOS reconnect half-size terminal fix, and an expo-modules-jsi pin for the iOS build.

## v1.14 — activity badges & render QA

- **Session activity badges** plus desktop notifications when a background terminal is waiting on you.
- Terminal rendering QA: stable row keys, background-color-erase (BCE), scrollback reflow, and measured font metrics.

## v1.13 — audit remediation & one-click downloads

- Security, reliability, mobile, and supply-chain hardening from a full audit.
- One-click "latest download" grid with stable release asset names.

## v1.12 — richer diffs

- Image diffs, a syntax-highlighted gutter, and a grouped file list in the diff view.

## v1.11 — diff view reliability

- Git diff view fixes: untracked files, renames, formatting, the file watcher, and correct cwd on reattach.

## v1.10 — in-app file & change review

- **Open terminal file links in-app** — tap a path in output to view the file.
- **Review workspace changes in-app** — see git changes without leaving the terminal.

## v1.9 — clipboard & keychain

- **OSC 52 clipboard write** — vim/tmux "yank to system clipboard" reaches the phone/desktop clipboard.
- **OSC 10/11 color-query reply** — fzf, lazygit, nvim, btop no longer hang querying terminal colors.
- **Desktop bell/finish notifications** when the window is unfocused.
- Server password moved from plaintext localStorage to the **OS keychain** (macOS Keychain / Windows Credential Manager / Linux Secret Service), with a localStorage fallback.

## v1.8 — agent HTML previews

- Coding agents (Codex CLI, Claude Code) can show a generated HTML/CSS/JS **preview** beside terminals via `tether present`.

## v1.7 — Catppuccin themes

- Catppuccin app themes.

## v1.6 — native terminal features

- Native terminal feature set landed (PR #18).

## v1.5 — configurable desktop navigation

- Choose session navigation: persistent left sidebar, hover-to-reveal edge sidebar, or top tabs — set from the title-bar overflow menu, saved across restarts. Mobile navigation unchanged.

## v1.4 — desktop title bar & app decomposition

- Custom frameless title bar with native-feeling window controls (macOS keeps traffic lights; Windows/Linux get custom controls), full-width drag, double-click-to-maximize.
- Desktop fixes: Enter sends commands, block caret renders/blinks, output auto-scrolls, no focus glow, login form width-capped, macOS uses Cmd (not Ctrl) as clipboard modifier so Ctrl+C stays SIGINT.
- Internal: mobile `App.tsx` decomposed (2,617 → 42 lines) into components + a `useTetherApp` hook; desktop builds consolidated into the release workflow.

## v1.3.0 — desktop hardening

- In-app **auto-update** (signed, verified against a bundled key) with a download progress dialog; AppImage/Windows/macOS self-update, `.deb`/`.rpm` are pointed to the new package.
- **Window state** persists (size, position, maximized).
- **Right-click menu** in the terminal: Copy / Paste / Select all.
- Terminal input correctness: application-cursor keys (DECCKM), AltGr composed characters, and mouse-wheel forwarding to mouse-reporting TUIs.

## v1.2.1 — desktop-tuned UI

- Docked session sidebar (replaces the slide-in drawer), physical keyboard, native mouse text selection, no on-screen key bar.

## v1.2.0 — desktop client

- Native [Tauri](https://tauri.app) desktop app for Linux, Windows, and macOS.

## v1.1.0 — single-binary server

- Server ships as one self-contained compiled binary; `tether update` self-updates it.

## v1.0.7 — trust, recovery & honesty

- Shared-password authentication with first-run TOFU pairing, a verifiable connection-test setup flow, and honest connection-status copy. Replaced in v4.0 by per-device Noise pairing.

## v1.0.0 – v1.0.6

- Initial releases: persistent PTY sessions, SQLite replay on reconnect, the mobile VT emulator, multi-terminal tabs, wrapped-link detection, and diff-based input (voice/swipe).

_Patch releases (v1.0.8–v1.0.10) folded in review fixes, dropped an unused Face ID permission, and fixed installer lockfile drift._

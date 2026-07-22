# Changelog

Newest first. Full notes on each [GitHub release](https://github.com/samuelloranger/tether/releases).

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

- Shared-password authentication with first-run TOFU pairing, a verifiable connection-test setup flow, and honest connection-status copy.

## v1.0.0 – v1.0.6

- Initial releases: persistent PTY sessions, SQLite replay on reconnect, the mobile VT emulator, multi-terminal tabs, wrapped-link detection, and diff-based input (voice/swipe).

_Patch releases (v1.0.8–v1.0.10) folded in review fixes, dropped an unused Face ID permission, and fixed installer lockfile drift._

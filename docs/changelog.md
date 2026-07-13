# Changelog

Newest first. Full notes on each [GitHub release](https://github.com/samuelloranger/tether/releases).

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

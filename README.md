<p align="center">
  <img src="apps/mobile/assets/icon.png" width="96" alt="Tether icon" />
</p>

<h1 align="center">Tether</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/samuelloranger/tether" alt="License: GPL-3.0" /></a>
  <a href="https://github.com/samuelloranger/tether/releases"><img src="https://img.shields.io/github/v/release/samuelloranger/tether" alt="Latest release" /></a>
  <a href="https://github.com/samuelloranger/tether/actions/workflows/ci.yml"><img src="https://github.com/samuelloranger/tether/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/samuelloranger/tether/actions/workflows/release.yml"><img src="https://github.com/samuelloranger/tether/actions/workflows/release.yml/badge.svg" alt="Release builds" /></a>
  <img src="https://img.shields.io/badge/platforms-iOS%20%7C%20Android%20%7C%20Linux%20%7C%20Windows%20%7C%20macOS-blue" alt="Platforms: iOS, Android, Linux, Windows, macOS" />
</p>

A persistent remote-shell console: real PTY shells on your server, streamed to your phone over WebSocket. Shells keep running when you disconnect — and survive server restarts.

## Install the server

```bash
curl -fsSL https://samlo.cloud/tether/install.sh | sh
tether set-password
tether start
```

The installer detects your OS/arch and downloads a single self-contained binary (no bun, git, or node_modules needed) from the latest release into `~/.local/bin/tether`. If `tether` isn't found afterward, add `~/.local/bin` to your PATH (the installer prints the exact line, and the commands it prints use the full path meanwhile).

```bash
tether serve | start | stop | restart | status | logs | present | set-password | update | version
```

- **Update later:** `tether update` downloads the newest release binary and restarts.
- **macOS** binaries are unsigned — the first run may need: `xattr -d com.apple.quarantine ~/.local/bin/tether`.
- **Data** (sessions + password) lives in `~/.tether/config/tether.db`; override with `TETHER_DB_PATH`.
- Environment: `TETHER_PORT` (default 8085), `TETHER_DB_PATH`, `TETHER_REPO_SLUG`.

> **Security:** a password gates all access (set it on first install), but **traffic is unencrypted**. Run tether behind a tunnel (Tailscale / WireGuard / SSH) for encryption; keep it LAN-only otherwise.

## What you get

- **Persistent sessions** — each shell runs in a detached holder process. Client disconnects, server restarts, even `tether restart` upgrades: the shell (and whatever runs in it) keeps going.
- **Replay** — every byte is logged to SQLite; reconnecting clients catch up from where they left off, with no output lost while the server was down.
- **Mobile client** — multi-session tabs, full VT emulator (TUIs, box drawing, CJK/emoji), key repeat, search, snippets.
- **Desktop client** — the same terminal as a native Linux/Windows/macOS app (docked sidebar, physical keyboard, mouse selection, self-update).
- **Agent previews** — Codex CLI or Claude Code can run `tether present ./preview/index.html --project <name>` to open a watched HTML/CSS/JS preview on desktop or iOS. Install the optional agent skills with `tether present agent-install`; clear previews with `tether present reset [project-name]`.

## Mobile app (iOS)

Install via [AltStore](https://altstore.io) (one-time setup: install AltServer on your Mac/PC and use it to put AltStore on your iPhone — it signs apps with your own Apple ID):

1. In AltStore: **Sources → + →** add this source:

   ```
   https://raw.githubusercontent.com/samuelloranger/tether/main/altstore.json
   ```

2. Tether appears in **Browse** — install it from there. Updates show up in AltStore automatically when a new release is published.
3. Free Apple IDs sign apps for 7 days — AltStore auto-refreshes whenever it can reach AltServer on your network.

(Manual alternative: grab `tether-vX.Y.Z.ipa` from the [latest release](https://github.com/samuelloranger/tether/releases/latest) and open it via **My Apps → +** in AltStore.)

Point the app at your server's IP and port on first launch.

## Mobile app (Android)

Grab `tether-vX.Y.Z.apk` from the [latest release](https://github.com/samuelloranger/tether/releases/latest) and install it (allow installs from your browser when prompted).

For automatic updates, add this repo to [Obtainium](https://github.com/ImranR98/Obtainium): **Add App →** `https://github.com/samuelloranger/tether` — it tracks releases and updates the APK for you.

## Desktop app (Linux / Windows / macOS)

A native [Tauri](https://tauri.app) client — the same terminal, tuned for keyboard and mouse (docked session sidebar, physical keyboard, mouse selection, right-click menu). Download for your platform from the [latest release](https://github.com/samuelloranger/tether/releases/latest):

| Platform | File |
| --- | --- |
| Debian / Ubuntu / Mint | `Tether_*_amd64.deb` |
| Fedora / RHEL | `Tether-*.x86_64.rpm` |
| Any Linux (incl. Arch) | `Tether_*_amd64.AppImage` |
| Windows | `Tether_*_x64-setup.exe` or `.msi` |
| macOS (Apple Silicon) | `Tether_*_aarch64.dmg` |
| macOS (Intel) | `Tether_*_x64.dmg` |

The app checks for updates on launch: the **AppImage, Windows, and macOS** builds self-update in place; **`.deb`/`.rpm`** installs are pointed to the new package to install via your package manager. See [the docs](https://samlo.cloud/tether/desktop) for details.

## Building the app from source

Expo SDK 57 — Expo Go is *not* supported; use a dev build:

```bash
cd apps/mobile
npx expo run:ios --device   # iOS (Mac + Xcode)
npx expo run:android        # Android (device or emulator)
```

## Development

Bun-workspaces monorepo: `apps/server` (Bun + Hono + bun:sqlite) and `apps/mobile` (Expo RN).

```bash
bun install          # link all workspaces
bun dev:server       # backend on :8085, watch mode
bun dev:mobile       # Expo Metro bundler
bun lint             # Biome (server) + Expo lint (mobile)
bun format           # biome check --write (server)
```

Tests are plain assert scripts:

```bash
cd apps/server && TETHER_DB_PATH=/tmp/tether-test.db bun run src/server/db.test.ts
cd apps/mobile && bun run src/terminal.test.ts
```

See `CLAUDE.md` for architecture notes (data flow, holder processes, conventions).

## License

[GPL-3.0](./LICENSE)

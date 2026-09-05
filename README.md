<p align="center">
  <img src="icon.png" width="96" alt="Tether icon" />
</p>

<h1 align="center">Tether</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/samuelloranger/tether" alt="License: GPL-3.0" /></a>
  <a href="https://github.com/samuelloranger/tether/releases"><img src="https://img.shields.io/github/v/release/samuelloranger/tether" alt="Latest release" /></a>
  <a href="https://github.com/samuelloranger/tether/actions/workflows/ci.yml"><img src="https://github.com/samuelloranger/tether/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/samuelloranger/tether/actions/workflows/release.yml"><img src="https://github.com/samuelloranger/tether/actions/workflows/release.yml/badge.svg" alt="Release builds" /></a>
  <img src="https://img.shields.io/badge/platforms-iOS%20%7C%20Linux%20%7C%20Windows%20%7C%20macOS-blue" alt="Platforms: iOS, Linux, Windows, macOS" />
  <a href="https://buymeacoffee.com/samlo122"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black" alt="Buy me a coffee" /></a>
</p>

A persistent remote-shell console: real PTY shells on your server, streamed to your phone over WebSocket. Shells keep running when you disconnect — and survive server restarts.

## Download

Every link below always resolves to the **newest release** — no need to hunt through the release file list.

| What | Platform | Get the latest |
| --- | --- | --- |
| **Server** | Linux / macOS | `curl -fsSL https://samlo.cloud/tether/install.sh \| sh` (auto-detects OS/arch) |
| **Server** | Windows | `irm https://samlo.cloud/tether/install.ps1 \| iex` (PowerShell, x64) |
| Server binary | Linux x64 | [`tether-linux-x64`](https://github.com/samuelloranger/tether/releases/latest/download/tether-linux-x64) |
| Server binary | Linux arm64 | [`tether-linux-arm64`](https://github.com/samuelloranger/tether/releases/latest/download/tether-linux-arm64) |
| Server binary | macOS Apple Silicon | [`tether-darwin-arm64.tar.gz`](https://github.com/samuelloranger/tether/releases/latest/download/tether-darwin-arm64.tar.gz) |
| Server binary | macOS Intel | [`tether-darwin-x64.tar.gz`](https://github.com/samuelloranger/tether/releases/latest/download/tether-darwin-x64.tar.gz) |
| Server binary | Windows x64 | [`tether-windows-x64.exe`](https://github.com/samuelloranger/tether/releases/latest/download/tether-windows-x64.exe) |
| **Mobile** | iOS | [TestFlight beta](https://testflight.apple.com/join/j7rPkfhq) (auto-updates) |
| **Desktop** | Linux / Windows / macOS | see [Desktop app](#desktop-app-linux--windows--macos) below |

Each `…/releases/latest/download/<file>` link is a permanent, one-click pointer to that file in whatever the current release is — safe to bookmark or share. (Desktop installers are versioned by the Tauri bundler, so they're picked per-file from the release page instead.)

## Install the server

Linux / macOS:

```bash
curl -fsSL https://samlo.cloud/tether/install.sh | sh
tether start
tether pair
```

The installer detects your OS/arch and downloads a single self-contained binary (no bun, git, or node_modules needed) from the latest release into `~/.local/bin/tether`. If `tether` isn't found afterward, add `~/.local/bin` to your PATH (the installer prints the exact line, and the commands it prints use the full path meanwhile).

Windows (PowerShell, x64 only):

```powershell
irm https://samlo.cloud/tether/install.ps1 | iex
tether start
tether pair
```

Same single binary, installed to `%LOCALAPPDATA%\Programs\tether\tether.exe` without an admin prompt, with that directory added to your user PATH — open a new terminal for it to take effect. See [the Windows server page](https://samlo.cloud/tether/windows) for supported shells, the firewall prompt on first start, and the platform's known limitations.

```bash
tether serve | start | stop | restart | status | logs | present | pair | update | version
```

- **Update later:** `tether update` downloads the newest release binary and restarts.
- **macOS** binaries are unsigned — the first run may need: `xattr -d com.apple.quarantine ~/.local/bin/tether`.
- **Data** (sessions + device registry) lives in `~/.tether/config/tether.db`; override with `TETHER_DB_PATH`.
- Environment: `TETHER_PORT` (default 8085), `TETHER_DB_PATH`, `TETHER_REPO_SLUG`.

> **Security:** access is per-device. Pair with `tether pair`; clients mint a short-lived bearer over Noise. The server serves TLS on `:8443` from a self-signed certificate clients pin on first pairing, alongside the plaintext `:8085` older clients use. The certificate is self-signed and CORS is open, so still run tether behind a tunnel (Tailscale / WireGuard / SSH) or keep it LAN-only.

## What you get

- **Persistent sessions** — each shell runs in a detached holder process. Client disconnects, server restarts, even `tether restart` upgrades: the shell (and whatever runs in it) keeps going.
- **Replay** — every byte is logged to SQLite; reconnecting clients catch up from where they left off, with no output lost while the server was down.
- **Mobile client** — multi-session tabs, full VT emulator (TUIs, box drawing, CJK/emoji), key repeat, search, snippets.
- **Desktop client** — the same terminal as a native Linux/Windows/macOS app (docked sidebar, physical keyboard, mouse selection, self-update).
- **Agent previews** — Codex CLI or Claude Code can run `tether present ./preview/index.html --project <name>` to open a watched HTML/CSS/JS preview on desktop or iOS. Install the optional agent skills with `tether present agent-install`; clear previews with `tether present reset [project-name]`.

## Mobile app (iOS)

Install [TestFlight](https://apps.apple.com/app/testflight/id899247664) from the App Store, then open the public beta link on your iPhone:

```
https://testflight.apple.com/join/j7rPkfhq
```

New builds arrive automatically; each is testable for 90 days. No Mac, no AltServer, and nothing to re-sign every week.

Native push notifications — the ones that arrive in Tether itself — require this build. Apple only issues push entitlements to properly signed apps, which is why sideloading is no longer offered.

Point the app at your server's IP and port on first launch.

## Android

Not supported. Android builds were discontinued after v2.8.12; `tether.apk` stays attached to the releases up to that version and is not updated. The Android APK was also signed with the public React Native debug keystore, so it never offered any authenticity guarantee.

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

The app checks for updates on launch and offers to install one when it finds it. Every format updates itself: the AppImage, Windows and macOS builds replace themselves in place, and `.deb`/`.rpm` installs hand the new package to your package manager, which asks for admin rights. See [the docs](https://samlo.cloud/tether/desktop) for details.

## Building the app from source

iOS needs a Mac + Xcode. From the repo root:

```bash
bash scripts/build-xcframework.sh
xcodebuild -project clients/apple/Tether.xcodeproj \
  -scheme TetherIOS \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Desktop: `bun dev:desktop` (or `bun --cwd apps/desktop run tauri:build`).

## Development

Bun-workspaces monorepo: `apps/server` (Bun + Hono + bun:sqlite), `apps/desktop` (Tauri), `apps/relay`, plus `clients/apple` (native iOS) and `crates/`.

```bash
bun install          # link all workspaces
bun dev:server       # backend on :8085, watch mode
bun dev:desktop      # Tauri desktop client
bun lint             # Biome + server/desktop typecheck
bun format           # biome check --write
```

Tests:

```bash
bun --cwd apps/server run test
bun --cwd apps/desktop run test
bun test scripts/
```

See `CLAUDE.md` for architecture notes (data flow, holder processes, conventions).

## License

[GPL-3.0](./LICENSE)

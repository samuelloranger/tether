# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tether v5 is a **native terminal for iOS, Mac, Windows and Linux that connects over SSH to `zmx`** — a persistent session manager running on your own hosts. The client speaks SSH straight to the host, attaches a zmx session, and renders the live PTY. Sessions survive disconnects because **zmx owns them on the host**; Tether is a pure client with no server of its own.

Tether through v4 was a Bun server + Noise transport with desktop and web clients. **All of that was removed in v5** — `apps/server`, `apps/desktop`, the VitePress docs site, and the whole Noise / holder / replay / WebSocket stack are gone. Do **not** reintroduce a server, a Noise channel, a WebSocket transport, or a web client. The desktop clients allowed are the native Windows and Linux app in `clients/desktop/` (one Rust codebase; spec: `clients/desktop/SPEC.md`) and the Mac Catalyst build of the iOS app; both are pure SSH-to-`zmx` clients like iOS. The only host-side artifact is `tether-notify`, a small Go tool for push. The push relay (`apps/relay`) is separate infrastructure, not part of any host: it routes ciphertext to APNs and is the only piece that holds the APNs key.

On iOS the VT emulator is SwiftTerm's headless engine, wrapped by `TerminalEngine` (pinned by revision in `TetherKit/Package.swift`). It does no networking — it only turns a PTY byte stream into a `TerminalFrame`; Tether renders its own grid. On Windows and Linux it is `alacritty_terminal`, rasterized to RGBA with `swash` (`tether-term`).

## Layout

| Path | Stack | What it is |
|---|---|---|
| `clients/apple/` | Swift / SwiftUI | The iOS app, also built for the Mac with Mac Catalyst ("Optimize for Mac" idiom, same bundle id and App Store Connect record). On the Mac the terminal screen shows one tab per `zmx` session (`MacSessionTabs`, one SSH connection per opened tab) instead of the drawer, with a menu bar (`TetherCommands`) and desktop pointer behaviour; every Mac difference is gated on `TetherPlatform.isMac`. `TetherKit` package (SSH transport, terminal pipeline + `TerminalEngine` + renderer, Home / key vault, all UI), `TetherIOS` app target, `TetherNotificationService` (NSE — decrypts push), `Tether.xcodeproj`. |
| `clients/desktop/` | Rust / Slint | The Windows and Linux app: SSH to `zmx`, one tab per session. Cargo workspace: `tether-core` (every rule as pure, host-free logic — profiles, keys, host-key pins, session list, git panel, markdown, agent badges), `tether-ssh` (`russh` transport, ProxyJump, SSH agent: Windows OpenSSH / Pageant, `SSH_AUTH_SOCK` on Linux), `tether-term` (`alacritty_terminal` + `swash` raster, inline images), `tether-app` (Slint UI + per-OS platform layer under `platform/windows` and `platform/linux`, Velopack self-update). Data lives in `%LOCALAPPDATA%\Tether` (Windows, secrets under DPAPI) or `$XDG_DATA_HOME/tether` (Linux, secrets in the Secret Service keyring). `SPEC.md` is the design; `design-preview/index.html` is the screen map. |
| `apps/tether-notify/` | Go | Host-side encrypted-push CLI. Registers a phone's APNs token + AES key (sent by the app over SSH) and posts ciphertext to the relay. |
| `apps/relay/` | Cloudflare Worker (Hono) | Push relay: forwards ciphertext to APNs (production first, sandbox on `BadDeviceToken`). Deployed on its own by `relay-deploy.yml` (wrangler); APNs config lives in Worker secrets. |
| `integrations/claude-code/` | Claude Code mod (TS) | `tether` plugin, published by the repo-root `.claude-plugin/marketplace.json`. Holds a permission prompt while no client is attached and applies the phone's Approve / Deny / Reply as the decision (`tether-notify hold` / `wait`); holds Claude's questions (`AskUserQuestion`, in any mode) and answers them from per-option notification buttons (the NSE registers a per-push category) or the app's answer sheet (`tether-notify pending`, `answer --option/--answers`). Never holds a `-p`/SDK run, a plugin's permission query, an agent under tmux/screen, or a mode that settles asks itself (auto, dontAsk, bypass) — the mode comes from classic events, or only the settings' `defaultMode` where an org guard blocks those for user mods. Installed by `install-agent-hooks.sh` on Claude Code ≥ 2.1.287. Test: `claude plugin test integrations/claude-code/tether`. |
| `scripts/` | shell / ruby | `install.sh` (install `tether-notify`), `install-agent-hooks.sh` (wire Claude Code, Codex, Gemini CLI and Cursor push), `release.sh`. |
| `.github/workflows/` | — | `ci.yml` (lint + host-tools + relay + iOS and Mac Catalyst build, TetherKit tests + Windows build/test/package, and the desktop build/lint/test/AppImage on Linux), `release.yml` (two lanes. A `vX.Y.Z` tag: signed iOS archive and Mac Catalyst pkg → TestFlight, Windows installer + portable zip and Linux AppImage attached to one GitHub release, then the stable desktop update feeds. Every push to main that CI passes: the same builds as the next patch version → TestFlight and the edge desktop channel, no release), `desktop-build.yml` (the Windows and Linux build `release.yml` calls), `relay-deploy.yml` (relay Worker deploy on tag or manual run). |

## Commands

**iOS (needs a Mac + Xcode):**

```bash
xcodebuild build -project clients/apple/Tether.xcodeproj \
  -scheme TetherIOS -destination 'generic/platform=iOS Simulator' \
  -configuration Debug -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO
xcodebuild test -scheme TetherKit -destination 'platform=iOS Simulator,name=iPhone 17' \
  -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO   # run from clients/apple/TetherKit
```

- Mac Catalyst: the same scheme with `-destination 'generic/platform=macOS,variant=Mac Catalyst'`. The SSH XCFrameworks carry an `ios-arm64_x86_64-maccatalyst` slice (`scripts/build-ssh-xcframeworks.sh`). Release CI builds instead of archiving: on Xcode 26 the Catalyst archive produces SwiftTerm's build-tool plugin executable twice and fails.
- macOS 27 hides menu images: Mac menu items use `MenuLabel` / `MenuIcon`, not a bare `Label` or `UIAction(image:)`.
- The iOS compile check is the **`TetherIOS` scheme via `xcodebuild`**, not `swift build` (bare SwiftPM builds for macOS; the vendored SSH XCFrameworks have no plain macOS slice).
- SwiftTerm runs a build-tool plugin: `xcodebuild` needs `-skipPackagePluginValidation` (Xcode asks once to trust it).

**Desktop (`clients/desktop/`, Rust stable; Windows and Linux):**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build -p tether-app                       # target/debug/tether(.exe)
pwsh packaging/package.ps1 -Version 0.0.0       # Windows: portable zip + MSIX into dist/
pwsh packaging/screenshots.ps1 -Out <dir>       # Windows: capture every screen of a debug build
```

- Every crate builds and tests on Linux, `tether-app` included. Linux build dependencies: `pkg-config` and `libfontconfig1-dev` (the windowing, GL and D-Bus libraries are loaded at run time). `packaging/linux/package.sh [version] [--skip-build] [--channel <name>]` builds the AppImage and the Velopack update package (needs `vpk` 1.2.161). Cross-check the Windows build from Linux with `cargo xwin`.
- The C runtime is linked statically (`.cargo/config.toml`): a fresh Windows has no VC++ redistributable.
- Debug builds read `TETHER_DEV_DATA`, `TETHER_DEV_PAGE`, `TETHER_DEV_THEME`, `TETHER_DEV_SIZE` to open one screen against sample data, and `TETHER_UPDATE_FEED` to point the updater at a local feed; release builds ignore them.
- Releases: the desktop client shares the app's version and its `vX.Y.Z` tag (`scripts/release.sh` bumps the workspace version and `Cargo.lock` with `package.json`); the release carries both OSes' files and one `SHA256SUMS.txt`. Installed apps update from the rolling `windows-feed` / `linux-feed` release, never from `releases/latest`: stable packages on Velopack's default channel (`releases.win.json`, `releases.linux.json`), edge builds of main on `win-edge` / `linux-edge`. There is one installer (the release's); Settings → About → Update channel picks which channel the updater reads (`update_channel` in preferences.json, passed to Velopack as `ExplicitChannel`), and **Check now** runs a check on demand.

**Host tools (`apps/tether-notify/`):**

```bash
go build ./... && go vet ./... && go test ./...
bash install.sh                            # build + install tether-notify to ~/.local/bin
bash scripts/install-agent-hooks.sh [host] # fire notifications from agent hooks
```

## Data flow (the core loop)

The steps name the iOS types; the desktop app runs the same loop through `tether-core` and `tether-ssh`, with keys in the DPAPI vault (Windows) or the Secret Service keyring (Linux) instead of the Keychain.

1. The app keeps SSH **host profiles** and **keys** (keys in the Keychain). Opening a machine → `SSHConnector` dials libssh2 to `host:port`.
2. **Host-key TOFU:** an unknown key is pinned on first connect; a later mismatch is **hard-refused, never overridden**.
3. **Auth** — a key held in memory (`publickey_frommemory`, no temp file) or a password — then a PTY channel, then `zmx attach <session>`.
4. PTY bytes → `TerminalPipeline` → `TerminalEngine` (SwiftTerm) → `TerminalFrame` → renderer. Input / resize / paste write back over the same channel. One dedicated thread drives the session (`SSHSessionPump`) — libssh2 sessions are not thread-safe.
5. **Everything else is a one-off `ssh exec`:** `zmx ls` (session list), `zmx history` (scrollback), `zmx kill`, `git … diff`, `scp` (send file/photo).
6. **Reconnect** is foreground-redial on `scenePhase .active`. On first connect the app attaches an existing session if the host has one, and only creates `default` when the host has none.

## Push

`tether-notify` on the host encrypts each notification with the device's AES-256-GCM key — wire format `base64(nonce[12] ‖ ciphertext ‖ tag[16])`, byte-identical to what the NSE decrypts — and POSTs the ciphertext to the relay (`tether-relay.samlo.cloud`; override with `TETHER_PUSH_RELAY_URL`). The relay and Apple never see plaintext. The app registers its token over SSH on connect; agent hooks call `tether-notify notify` on session state changes. Devices live in `~/.tether-notify/devices.json`. With the Claude Code mod installed, a permission prompt in an unattached session is held instead of drawn; the phone's answer reaches it through `tether-notify answer` → the answer file → `wait`, not `zmx send`.

## Security

- **Transport is SSH.** No shared password, no setup flow without host-key verification. Private keys live in the iOS Keychain (Windows: DPAPI-protected files under `%LOCALAPPDATA%\Tether`; Linux: the Secret Service keyring, never a plaintext file) and leave the device only in memory, to the SSH library.
- A host-key mismatch fails loudly and is never retried.
- The APNs signing key can never sit on a self-hosted host — the relay only routes ciphertext it cannot read (see the push section).

## Conventions & gotchas

- **Comments: minimal.** Only a non-obvious "why" or a gotcha. Never restate the code.
- Tests are colocated (`foo.swift` + `foo.test`-style targets in TetherKit; `_test.go` in Go). New logic ships with tests. Keep pure logic testable without a live host — **live SSH tests are DEBUG-env-gated and skip in CI.**

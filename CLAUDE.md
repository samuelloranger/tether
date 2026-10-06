# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tether v5 is a **native terminal for iOS and Windows that connects over SSH to `zmx`** — a persistent session manager running on your own hosts. The client speaks SSH straight to the host, attaches a zmx session, and renders the live PTY. Sessions survive disconnects because **zmx owns them on the host**; Tether is a pure client with no server of its own.

Tether through v4 was a Bun server + Noise transport with desktop and web clients. **All of that was removed in v5** — `apps/server`, `apps/desktop`, the VitePress docs site, and the whole Noise / holder / replay / WebSocket stack are gone. Do **not** reintroduce a server, a Noise channel, a WebSocket transport, or a web client. The one desktop client allowed is the native Windows app in `clients/windows/`, which is a pure SSH-to-`zmx` client like iOS; its spec is `clients/windows/SPEC.md`. The only host-side artifact is `tether-notify`, a small Go tool for push. The push relay (`apps/relay`) is separate infrastructure, not part of any host: it routes ciphertext to APNs and is the only piece that holds the APNs key.

On iOS the VT emulator is SwiftTerm's headless engine, wrapped by `TerminalEngine` (pinned by revision in `TetherKit/Package.swift`). It does no networking — it only turns a PTY byte stream into a `TerminalFrame`; Tether renders its own grid. On Windows it is `alacritty_terminal`, rasterized to RGBA with `swash` (`tether-term`).

## Layout

| Path | Stack | What it is |
|---|---|---|
| `clients/apple/` | Swift / SwiftUI | The iOS app. `TetherKit` package (SSH transport, terminal pipeline + `TerminalEngine` + renderer, Home / key vault, all UI), `TetherIOS` app target, `TetherNotificationService` (NSE — decrypts push), `Tether.xcodeproj`. |
| `clients/windows/` | Rust / Slint | The Windows app: SSH to `zmx`, one tab per session. Cargo workspace: `tether-core` (every rule as pure, host-free logic — profiles, keys, host-key pins, session list, git panel, markdown, agent badges), `tether-ssh` (`russh` transport, ProxyJump, agent / Pageant), `tether-term` (`alacritty_terminal` + `swash` raster, inline images), `tether-app` (Slint UI + Win32 glue, Velopack self-update). Data lives in `%LOCALAPPDATA%\Tether`, secrets under DPAPI. `SPEC.md` is the design; `design-preview/index.html` is the screen map. |
| `apps/tether-notify/` | Go | Host-side encrypted-push CLI. Registers a phone's APNs token + AES key (sent by the app over SSH) and posts ciphertext to the relay. |
| `apps/relay/` | Cloudflare Worker (Hono) | Push relay: forwards ciphertext to APNs (production first, sandbox on `BadDeviceToken`). Deployed on its own by `relay-deploy.yml` (wrangler); APNs config lives in Worker secrets. |
| `integrations/claude-code/` | Claude Code mod (TS) | `tether` plugin, published by the repo-root `.claude-plugin/marketplace.json`. Holds a permission prompt while no client is attached and applies the phone's Approve / Deny / Reply as the decision (`tether-notify hold` / `wait`); holds Claude's questions (`AskUserQuestion`, in any mode) and answers them from per-option notification buttons (the NSE registers a per-push category) or the app's answer sheet (`tether-notify pending`, `answer --option/--answers`). Never holds a `-p`/SDK run, a plugin's permission query, an agent under tmux/screen, or a mode that settles asks itself (auto, dontAsk, bypass) — the mode comes from classic events, or only the settings' `defaultMode` where an org guard blocks those for user mods. Installed by `install-agent-hooks.sh` on Claude Code ≥ 2.1.287. Test: `claude plugin test integrations/claude-code/tether`. |
| `scripts/` | shell / ruby | `install.sh` (install `tether-notify`), `install-agent-hooks.sh` (wire agent push), `release.sh`. |
| `.github/workflows/` | — | `ci.yml` (lint + host-tools + relay + iOS build/test + Windows build/test/package, and the three library crates on Linux), `release.yml` (signed iOS archive → TestFlight), `relay-deploy.yml` (relay Worker deploy on tag or manual run), `windows-release.yml` (Windows installer + portable zip on a `windows-vX.Y.Z` tag; updates the `windows-feed` release installed apps update from). |

## Commands

**iOS (needs a Mac + Xcode):**

```bash
xcodebuild build -project clients/apple/Tether.xcodeproj \
  -scheme TetherIOS -destination 'generic/platform=iOS Simulator' \
  -configuration Debug -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO
xcodebuild test -scheme TetherKit -destination 'platform=iOS Simulator,name=iPhone 17' \
  -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO   # run from clients/apple/TetherKit
```

- The iOS compile check is the **`TetherIOS` scheme via `xcodebuild`**, not `swift build` (bare SwiftPM builds for macOS; the vendored SSH XCFrameworks are iOS-only).
- SwiftTerm runs a build-tool plugin: `xcodebuild` needs `-skipPackagePluginValidation` (Xcode asks once to trust it).

**Windows (`clients/windows/`, Rust stable):**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build -p tether-app                       # target/debug/tether.exe
pwsh packaging/package.ps1 -Version 0.0.0       # portable zip + MSIX into dist/
pwsh packaging/screenshots.ps1 -Out <dir>       # capture every screen of a debug build
```

- `tether-core`, `tether-ssh` and `tether-term` build and test on Linux; only `tether-app` needs Windows (or `cargo xwin`).
- The C runtime is linked statically (`.cargo/config.toml`): a fresh Windows has no VC++ redistributable.
- Debug builds read `TETHER_DEV_DATA`, `TETHER_DEV_PAGE`, `TETHER_DEV_THEME`, `TETHER_DEV_SIZE` to open one screen against sample data; release builds ignore them.
- Releases: push a `windows-vX.Y.Z` tag. Installed apps update from the rolling `windows-feed` release, never from `releases/latest` (that stays the iOS app).

**Host tools (`apps/tether-notify/`):**

```bash
go build ./... && go vet ./... && go test ./...
bash install.sh                            # build + install tether-notify to ~/.local/bin
bash scripts/install-agent-hooks.sh [host] # fire notifications from agent hooks
```

## Data flow (the core loop)

The steps name the iOS types; the Windows app runs the same loop through `tether-core` and `tether-ssh`, with keys in the DPAPI vault instead of the Keychain.

1. The app keeps SSH **host profiles** and **keys** (keys in the Keychain). Opening a machine → `SSHConnector` dials libssh2 to `host:port`.
2. **Host-key TOFU:** an unknown key is pinned on first connect; a later mismatch is **hard-refused, never overridden**.
3. **Auth** — a key held in memory (`publickey_frommemory`, no temp file) or a password — then a PTY channel, then `zmx attach <session>`.
4. PTY bytes → `TerminalPipeline` → `TerminalEngine` (SwiftTerm) → `TerminalFrame` → renderer. Input / resize / paste write back over the same channel. One dedicated thread drives the session (`SSHSessionPump`) — libssh2 sessions are not thread-safe.
5. **Everything else is a one-off `ssh exec`:** `zmx ls` (session list), `zmx history` (scrollback), `zmx kill`, `git … diff`, `scp` (send file/photo).
6. **Reconnect** is foreground-redial on `scenePhase .active`. On first connect the app attaches an existing session if the host has one, and only creates `default` when the host has none.

## Push

`tether-notify` on the host encrypts each notification with the device's AES-256-GCM key — wire format `base64(nonce[12] ‖ ciphertext ‖ tag[16])`, byte-identical to what the NSE decrypts — and POSTs the ciphertext to the relay (`tether-relay.samlo.cloud`; override with `TETHER_PUSH_RELAY_URL`). The relay and Apple never see plaintext. The app registers its token over SSH on connect; agent hooks call `tether-notify notify` on session state changes. Devices live in `~/.tether-notify/devices.json`. With the Claude Code mod installed, a permission prompt in an unattached session is held instead of drawn; the phone's answer reaches it through `tether-notify answer` → the answer file → `wait`, not `zmx send`.

## Security

- **Transport is SSH.** No shared password, no setup flow without host-key verification. Private keys live in the iOS Keychain (Windows: DPAPI-protected files under `%LOCALAPPDATA%\Tether`) and leave the device only in memory, to the SSH library.
- A host-key mismatch fails loudly and is never retried.
- The APNs signing key can never sit on a self-hosted host — the relay only routes ciphertext it cannot read (see the push section).

## Conventions & gotchas

- **Comments: minimal.** Only a non-obvious "why" or a gotcha. Never restate the code.
- Tests are colocated (`foo.swift` + `foo.test`-style targets in TetherKit; `_test.go` in Go). New logic ships with tests. Keep pure logic testable without a live host — **live SSH tests are DEBUG-env-gated and skip in CI.**

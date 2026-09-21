# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tether v5 is a **native iOS terminal that connects over SSH to `zmx`** — a persistent session manager running on your own hosts. The phone speaks libssh2 straight to the host, attaches a zmx session, and renders the live PTY. Sessions survive disconnects because **zmx owns them on the host**; Tether is a pure client with no server of its own.

Tether through v4 was a Bun server + Noise transport with desktop and web clients. **All of that was removed in v5** — `apps/server`, `apps/desktop`, `apps/relay`, the VitePress docs site, and the whole Noise / holder / replay / WebSocket stack are gone. Do **not** reintroduce a server, a Noise channel, a WebSocket transport, or a desktop/web client. The only host-side artifact is `tether-notify`, a small Go tool for push.

The one piece of Rust that stayed is the **VT emulator** (`crates/`), consumed by the app as an XCFramework. It does no networking — it only turns a PTY byte stream into a terminal grid.

## Layout

| Path | Stack | What it is |
|---|---|---|
| `clients/apple/` | Swift / SwiftUI | The iOS app. `TetherKit` package (SSH transport, terminal pipeline + renderer, Home / key vault, all UI), `TetherIOS` app target, `TetherNotificationService` (NSE — decrypts push), `Tether.xcodeproj`. |
| `crates/` | Rust | `tether-core` / `tether-ffi` / `tether-proto` — the VT emulator (grid model) exposed to Swift via UniFFI. **Renderer only, no networking.** |
| `apps/tether-notify/` | Go | Host-side encrypted-push CLI. Registers a phone's APNs token + AES key (sent by the app over SSH) and posts ciphertext to the relay. |
| `scripts/` | shell / ruby | `build-xcframework.sh` (Rust emulator → Swift bindings), `install.sh` (install `tether-notify`), `install-agent-hooks.sh` (wire agent push), `release.sh`. |
| `.github/workflows/` | — | `ci.yml` (lint + host-tools + iOS build/test), `release.yml` (signed iOS archive → TestFlight). |

## Commands

**iOS (needs a Mac + Xcode):**

```bash
bash scripts/build-xcframework.sh          # build the Rust emulator XCFramework + Swift bindings
xcodebuild build -project clients/apple/Tether.xcodeproj \
  -scheme TetherIOS -destination 'generic/platform=iOS Simulator' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO
xcodebuild test -scheme TetherKit -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGNING_ALLOWED=NO                   # run from clients/apple/TetherKit
```

- Run `build-xcframework.sh` **before the first Xcode build and after any `crates/` change** — a stale XCFramework silently hides core changes.
- The iOS compile check is the **`TetherIOS` scheme via `xcodebuild`**, not `swift build` (bare SwiftPM can't resolve the generated FFI bindings).

**Host tools (`apps/tether-notify/`):**

```bash
go build ./... && go vet ./... && go test ./...
bash install.sh                            # build + install tether-notify to ~/.local/bin
bash scripts/install-agent-hooks.sh [host] # fire notifications from agent hooks
```

## Data flow (the core loop)

1. The app keeps SSH **host profiles** and **keys** (keys in the Keychain). Opening a machine → `SSHConnector` dials libssh2 to `host:port`.
2. **Host-key TOFU:** an unknown key is pinned on first connect; a later mismatch is **hard-refused, never overridden**.
3. **Auth** — a key held in memory (`publickey_frommemory`, no temp file) or a password — then a PTY channel, then `zmx attach <session>`.
4. PTY bytes → `TerminalPipeline` → Rust emulator grid snapshot → SwiftUI renderer. Input / resize / paste write back over the same channel. One dedicated thread drives the session (`SSHSessionPump`) — libssh2 sessions are not thread-safe.
5. **Everything else is a one-off `ssh exec`:** `zmx ls` (session list), `zmx history` (scrollback), `zmx kill`, `git … diff`, `scp` (send file/photo).
6. **Reconnect** is foreground-redial on `scenePhase .active`. On first connect the app attaches an existing session if the host has one, and only creates `default` when the host has none.

## Push

`tether-notify` on the host encrypts each notification with the device's AES-256-GCM key — wire format `base64(nonce[12] ‖ ciphertext ‖ tag[16])`, byte-identical to what the NSE decrypts — and POSTs the ciphertext to the relay (`tether-relay.samlo.cloud`; override with `TETHER_PUSH_RELAY_URL`). The relay and Apple never see plaintext. The app registers its token over SSH on connect; agent hooks call `tether-notify notify` on session state changes. Devices live in `~/.tether-notify/devices.json`.

## Security

- **Transport is SSH.** No shared password, no setup flow without host-key verification. Private keys live in the iOS Keychain and leave the device only in memory, to libssh2.
- A host-key mismatch fails loudly and is never retried.
- The APNs signing key can never sit on a self-hosted host — the relay only routes ciphertext it cannot read (see the push section).

## Conventions & gotchas

- **Comments: minimal.** Only a non-obvious "why" or a gotcha. Never restate the code.
- Tests are colocated (`foo.swift` + `foo.test`-style targets in TetherKit; `_test.go` in Go). New logic ships with tests. Keep pure logic testable without a live host — **live SSH tests are DEBUG-env-gated and skip in CI.**
- A `crates/` edit needs `build-xcframework.sh` or the app links the old binary.
- `uniffi` named constructors become Swift `static` factory methods, not initializers — only a real `xcodebuild` catches the mismatch.

# Tether iOS (native SwiftUI)

Native iOS client for Tether. Connects over SSH (libssh2) to `zmx` on a host and renders the live PTY. Consumes the Rust VT emulator (`tether-ffi`) via an XCFramework built by `scripts/build-xcframework.sh`.

## Layout

```
clients/apple/
  Tether.xcodeproj/              Xcode project (scheme: TetherIOS)
  TetherKit/                     Shared Swift package (SSH transport + terminal + Home/vault + UI)
  TetherIOS/                     iOS app target
  TetherNotificationService/     Notification Service Extension (push decrypt)
  Frameworks/                    Vendored XCFrameworks (SSH: libssh2/openssl) + generated TetherFFI
```

## Build (macOS + Xcode only)

```bash
# From repo root — builds Rust FFI, generates Swift bindings, assembles XCFramework
bash scripts/build-xcframework.sh

# Build the iOS app (matches CI)
xcodebuild -project clients/apple/Tether.xcodeproj \
  -scheme TetherIOS \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  build
```

The XCFramework and Swift binding paths are fixed contracts — do not relocate them.

## Architecture

- **SSH transport** — `SSHConnector` dials libssh2 on a dedicated thread; `SSHConnectionSequence` gates connect → host-key TOFU → auth; `SSHSessionPump` drives one session (input/read/resize) since libssh2 sessions are not thread-safe. Keys come from the Keychain in memory (`publickey_frommemory`).
- **Terminal** — PTY bytes flow through `TerminalPipeline` into the Rust emulator; `TetherSurfaceView` decodes packed TGRD grid snapshots and draws with CoreText (generation-gated redraw).
- **Home** — `HomeModel` + the SSH host-profile store and key vault (generate / import / paste ed25519, randomart, fingerprint).
- **App shell** — `AppRootView` (Home ↔ terminal), `SSHTerminalController` (connect, `zmx attach`, foreground-redial, session drawer, git diff over exec, send file/photo), deep links (`tether://session/<id>?host=<label>`).

## Running the TetherKit tests

```sh
cd clients/apple/TetherKit
xcodebuild test -scheme TetherKit -destination "id=<simulator-udid>"
```

`swift test` does **not** work here, and its failure is misleading — it
reports dozens of `cannot find 'uniffi_tether_ffi_...' in scope` errors that
look like broken bindings. The cause is that `swift test` builds for the host
(macOS) while `Frameworks/TetherFFI.xcframework` carries iOS device and iOS
simulator slices only, so the C symbols genuinely are not there. Give
`xcodebuild` a simulator destination and they are.

The suite covers the pure logic only — host-key TOFU, credential ordering, the
connect state machine (behind an ops seam), `zmx ls` / git-diff parsing, key
encoding and randomart, grid-to-text flattening. Anything touching the Keychain
or a live SSH host is DEBUG-env-gated (skips in CI) and verified by driving the
simulator or a real host instead.

Before an app build, run `../../scripts/check-xcframework-fresh.sh`: TetherKit
links `tether-ffi` as a SwiftPM `.binaryTarget`, so a change under `crates/`
compiles, passes `cargo test`, builds the app — and is absent from it.

# Tether iOS (native SwiftUI)

Native iOS client for Tether. Connects over SSH (libssh2) to `zmx` on a host and renders the live PTY. The VT emulator is SwiftTerm's headless engine (`TerminalEngine`); TetherKit renders the grid itself.

## Layout

```
clients/apple/
  Tether.xcodeproj/              Xcode project (scheme: TetherIOS)
  TetherKit/                     Shared Swift package (SSH transport + terminal + Home/vault + UI)
  TetherIOS/                     iOS app target
  TetherNotificationService/     Notification Service Extension (push decrypt)
  Frameworks/                    Vendored XCFrameworks (SSH: libssh2/openssl)
```

## Build (macOS + Xcode 26 or later)

```bash
# Build the iOS app (matches CI)
xcodebuild -project clients/apple/Tether.xcodeproj \
  -scheme TetherIOS \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug \
  -skipPackagePluginValidation \
  CODE_SIGNING_ALLOWED=NO \
  build
```

`-skipPackagePluginValidation` is needed because SwiftTerm runs a build-tool plugin.

## Architecture

- **SSH transport** — `SSHConnector` dials libssh2 on a dedicated thread; `SSHConnectionSequence` gates connect → host-key TOFU → auth; `SSHSessionPump` drives one session (input/read/resize) since libssh2 sessions are not thread-safe. Keys come from the Keychain in memory (`publickey_frommemory`).
- **Terminal** — PTY bytes flow through `TerminalPipeline` into `TerminalEngine` (SwiftTerm), which hands `TetherSurfaceView` a `TerminalFrame` to draw with CoreText (generation-gated redraw).
- **Home** — `HomeModel` + the SSH host-profile store and key vault (generate / import / paste ed25519, randomart, fingerprint).
- **App shell** — `AppRootView` (Home ↔ terminal), `SSHTerminalController` (connect, `zmx attach`, foreground-redial, session drawer, git diff over exec, send file/photo), deep links (`tether://session/<id>?host=<label>`).

## Running the TetherKit tests

```sh
cd clients/apple/TetherKit
xcodebuild test -scheme TetherKit -destination "id=<simulator-udid>" -skipPackagePluginValidation
```

`swift test` does **not** work here: it builds for the host (macOS) while the
vendored SSH XCFrameworks carry iOS device and simulator slices only. Give
`xcodebuild` a simulator destination (and `-skipPackagePluginValidation`).

The suite covers the pure logic only — host-key TOFU, credential ordering, the
connect state machine (behind an ops seam), `zmx ls` / git-diff parsing, key
encoding and randomart, grid-to-text flattening. Anything touching the Keychain
or a live SSH host is DEBUG-env-gated (skips in CI) and verified by driving the
simulator or a real host instead.

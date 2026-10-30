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

## Chat organization and branching

The session drawer groups chats by repository (working folder when the host cannot identify a repository). Pin a chat to keep it above the project groups. A chat's trailing menu also offers Rename, Archive/Restore, and a separate confirmed Delete action. Archive hides a chat without stopping its agent; archived chats waiting for an answer remain visible under Needs you.

Long-press a text prompt and choose **Branch & edit…** to create a separate conversation with an editable, unsent prompt. The sheet explicitly copies earlier user/assistant text into a fresh agent session; it does not perform a native session fork, restore files, or create a Git worktree. The child links to its original conversation. Earlier images and copied context over 128 KiB are refused with an explanation rather than silently omitted or truncated. The context seed and draft persist locally, and a failed first send keeps them for an explicit retry.

The drawer footer shows Claude and Codex account usage on the selected host: 5-hour and weekly percent used, reset time, and freshness. Missing windows show a dash. Readings are account-wide, not this chat's token count. The app asks at most once a minute while the drawer is visible and connected; unavailable hosts retain the last reading with its age. Update the host's `tether` tool to use organization and plan-usage commands.

Additional DEBUG screenshot fixtures: `TETHER_DEBUG_DRAWER=projects-open|projects-archive|projects-unavailable`, and `TETHER_DEBUG_CHAT_FIXTURE=branch|branch-child`.

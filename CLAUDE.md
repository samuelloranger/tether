# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tether v5 is a **native terminal for iOS, Mac, Windows and Linux that connects over SSH to `zmx`** — a persistent session manager running on your own hosts. The client speaks SSH straight to the host, attaches a zmx session, and renders the live PTY. Sessions survive disconnects because **zmx owns them on the host**; Tether is a pure client with no server of its own. Besides terminal sessions the iOS app and the desktop client also have an **ACP chat client**: a chat with Claude Code on the host, spoken over an ssh exec channel to a small holder process (`tether acp`) that keeps the agent alive across disconnects.

Tether through v4 was a Bun server + Noise transport with desktop and web clients. **All of that was removed in v5** — `apps/server`, `apps/desktop`, the VitePress docs site, and the whole Noise / holder / replay / WebSocket stack are gone. Do **not** reintroduce a server, a Noise channel, a WebSocket transport, or a web client. The desktop clients allowed are the native Windows and Linux app in `clients/desktop/` (one Rust codebase; spec: `clients/desktop/SPEC.md`) and the Mac Catalyst build of the iOS app; both are pure SSH-to-`zmx` clients like iOS. The only host-side artifact is `tether`, a small Go tool for push and for the chat holder (`tether acp`). The push relay (`apps/relay`) is separate infrastructure, not part of any host: it routes ciphertext to APNs and is the only piece that holds the APNs key.

On iOS the VT emulator is SwiftTerm's headless engine, wrapped by `TerminalEngine` (pinned by revision in `TetherKit/Package.swift`). It does no networking — it only turns a PTY byte stream into a `TerminalFrame`; Tether renders its own grid. On Windows and Linux it is `alacritty_terminal`, rasterized to RGBA with `swash` (`tether-term`).

## Layout

| Path | Stack | What it is |
|---|---|---|
| `clients/apple/` | Swift / SwiftUI | The iOS app, also built for the Mac with Mac Catalyst ("Optimize for Mac" idiom, same bundle id and App Store Connect record). On the Mac the terminal screen shows one tab per `zmx` session (`MacSessionTabs`, one SSH connection per opened tab) instead of the drawer, with a menu bar (`TetherCommands`) and desktop pointer behaviour; every Mac difference is gated on `TetherPlatform.isMac`. `TetherKit` package (SSH transport, terminal pipeline + `TerminalEngine` + renderer, Home / key vault, all UI, and the ACP chat client: `ACP/` is the protocol client, journal, snapshots and the transcript reducer, `Chat/` the chat screens and session model; chats talk to `tether acp attach` over an exec channel and run the pinned `claude-agent-acp` adapter through `npx`, so a host needs Node.js), `TetherIOS` app target, `TetherNotificationService` (NSE — decrypts push), `Tether.xcodeproj`. |
| `clients/desktop/` | Rust / Slint | The Windows and Linux app: SSH to `zmx`, one tab per session, and the ACP chat as tabs beside them (`tether-core::acp` is the protocol client, reducer, journal and snapshots ported from `TetherKit/ACP`; `tether-app/src/terminal/model/chat` is the session model). Cargo workspace: `tether-core` (every rule as pure, host-free logic — profiles, keys, host-key pins, session list, git panel, markdown, agent badges), `tether-ssh` (`russh` transport, ProxyJump, SSH agent: Windows OpenSSH / Pageant, `SSH_AUTH_SOCK` on Linux), `tether-term` (`alacritty_terminal` + `swash` raster, inline images), `tether-app` (Slint UI + per-OS platform layer under `platform/windows` and `platform/linux`, Velopack self-update). Data lives in `%LOCALAPPDATA%\Tether` (Windows, secrets under DPAPI) or `$XDG_DATA_HOME/tether` (Linux, secrets in the Secret Service keyring). `SPEC.md` is the design; `design-preview/index.html` is the screen map. |
| `apps/tether/` | Go | Host-side CLI: encrypted push (registers a phone's APNs token + AES key, sent by the app over SSH, and posts ciphertext to the relay) and the chat holder `tether acp` (spawns the agent, keeps its byte log, serves attach / ls / kill / answers). See its README. |
| `apps/relay/` | Cloudflare Worker (Hono) | Push relay: forwards ciphertext to APNs (production first, sandbox on `BadDeviceToken`). Deployed on its own by `relay-deploy.yml` (wrangler); APNs config lives in Worker secrets. |
| `integrations/claude-code/` | Claude Code mod (TS) | `tether` plugin, published by the repo-root `.claude-plugin/marketplace.json`. Holds a permission prompt while no client is attached and applies the phone's Approve / Deny / Reply as the decision (`tether hold` / `wait`); holds Claude's questions (`AskUserQuestion`, in any mode) and answers them from per-option notification buttons (the NSE registers a per-push category) or the app's answer sheet (`tether pending`, `answer --option/--answers`). Never holds a `-p`/SDK run, a plugin's permission query, an agent under tmux/screen, or a mode that settles asks itself (auto, dontAsk, bypass) — the mode comes from the settings' `defaultMode` only, since an org guard keeps classic events from user mods. Installed by `install-agent-hooks.sh` on Claude Code ≥ 2.1.287. Test: `claude plugin test integrations/claude-code/tether`. |
| `scripts/` | shell / ruby | `install.sh` (install `tether`), `install-agent-hooks.sh` (wire Claude Code, Codex, Gemini CLI and Cursor push), `release.sh`. |
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

**Host tools (`apps/tether/`):**

```bash
go build ./... && go vet ./... && go test ./...
bash install.sh                            # build + install tether to ~/.local/bin (sets the version; moves a legacy v4 `tether` aside)
sh scripts/install.test.sh                 # installer logic against a temp bin dir
bash scripts/install-agent-hooks.sh [host] # fire notifications from agent hooks
```

Chat code lives in `clients/apple/TetherKit/Sources/TetherKit/{ACP,Chat}` with tests in `Tests/TetherKitTests` (`ACP*`, `Chat*`). Run one suite with `macbuild test --only TetherKitTests/<Suite>`; DEBUG fixtures for screenshots are `TETHER_DEBUG_CHAT_FIXTURE=<mode>` (see `Chat/ChatFixture.swift`; build before `macbuild shots`, which does not). Chat files (snapshots, outbox) are stored under Application Support with file protection until first unlock and excluded from backups.

Chat behaviours worth knowing: the drawer lists chats from `tether acp status` (one JSON line each: working, needs you, idle, ended; the host's title wins over the stored one) and falls back to `acp ls` (running or ended only) when the host answers "unknown command"; the drawer button and the chat's menu button carry a dot while any other chat is waiting, and the status is re-read on the same 5 s tick as the terminal agent status, only while the host has chats. The New chat sheet has a Continue mode: `acp sessions <folder> --limit 20` lists earlier conversations, and starting one sends `session/load {sessionId, cwd, mcpServers: []}` instead of `session/new`; the agent replays the history as `session/update` notifications before it answers the load (user_message_chunk, tool_call and its updates, agent_message_chunk), and the journal's `loadedSessionId` makes a redial before the answer ask for the same conversation. Typing `@` at the start of a word in the composer opens a file palette fed by one `sh -c` listing in the chat's folder (`git ls-files`, else `find`), cached per chat for 60 s; a pick writes plain `@relative/path ` into the draft, which the adapter inlines (a resource_link block would show a Read call instead). The live holder test (`SSHLiveACPHolderTests`) needs a host with `tether` and the `TETHER_SSH_*` variables.

## Data flow (the core loop)

The terminal loop below is the zmx path. Chats are separate: the app dials `tether acp attach <name> --from <offset>` over an ssh exec channel, the holder replays its byte log from that offset, and `ACPClient` feeds the lines through `ChatTranscriptBuilder` (agent lines merged with the phone's own journal by log offset, so replay equals live).

The steps name the iOS types; the desktop app runs the same loop through `tether-core` and `tether-ssh`, with keys in the DPAPI vault (Windows) or the Secret Service keyring (Linux) instead of the Keychain.

1. The app keeps SSH **host profiles** and **keys** (keys in the Keychain). Opening a machine → `SSHConnector` dials libssh2 to `host:port`.
2. **Host-key TOFU:** an unknown key is pinned on first connect; a later mismatch is **hard-refused, never overridden**.
3. **Auth** — a key held in memory (`publickey_frommemory`, no temp file) or a password — then a PTY channel, then `zmx attach <session>`.
4. PTY bytes → `TerminalPipeline` → `TerminalEngine` (SwiftTerm) → `TerminalFrame` → renderer. Input / resize / paste write back over the same channel. One dedicated thread drives the session (`SSHSessionPump`) — libssh2 sessions are not thread-safe.
5. **Everything else is a one-off `ssh exec`:** `zmx ls` (session list), `zmx history` (scrollback), `zmx kill`, `git … diff`, `scp` (send file/photo).
6. **Reconnect** is foreground-redial on `scenePhase .active`. **The app never opens a session by itself** (and `zmx attach` creates any name the host lacks). A fresh screen attaches nothing: its empty-state card lists the host's sessions to pick from and offers New session, the only path that creates one; a Mac window starts with no active tab. Only a session the user chose (a tap, New session, a notification) is attached, and only if `zmx ls` lists it: a redial re-attaches it while it exists, a session that ended leaves the empty state, and killing the current session does too. A `zmx ls` that fails is retried, and the chosen session is attached by the next listing that shows it.

## Push

`tether` on the host encrypts each notification with the device's AES-256-GCM key — wire format `base64(nonce[12] ‖ ciphertext ‖ tag[16])`, byte-identical to what the NSE decrypts — and POSTs the ciphertext to the relay (`tether-relay.samlo.cloud`; override with `TETHER_PUSH_RELAY_URL`). The relay and Apple never see plaintext. The app registers its token over SSH on connect; agent hooks call `tether notify` on session state changes. Devices live in `~/.tether-notify/devices.json`. With the Claude Code mod installed, a permission prompt in an unattached session is held instead of drawn; the phone's answer reaches it through `tether answer` → the answer file → `wait`, not `zmx send`.

## ACP chat push

When nobody is attached to a held ACP chat, the host's `acp` holder pushes through the same relay: `tether.acp.permission` (urgent, one button per option, at most 4, from the push's `options`; the NSE registers a per-push category `tether.acp.permission.<version>` and the reject kinds are destructive) and a quiet `tether.acp.done` when a turn ends. A button runs `tether acp answer <acp> --request <id> --option <optionId>` over a one-off SSH exec (exit 3 = already answered); the body links to `tether://chat/<name>?host=<label>`, which opens that chat in the terminal screen. On reconnect the chat reads `tether acp answers <acp>` and merges those answers into its journal so the replay shows them resolved. The identity is registered from the terminal connection, or from the chat list when it is opened without one. Dev-signed builds get no push (the relay's APNs key is production-only), so the buttons are only exercisable on a TestFlight build.

## Security

- **Transport is SSH.** No shared password, no setup flow without host-key verification. Private keys live in the iOS Keychain (Windows: DPAPI-protected files under `%LOCALAPPDATA%\Tether`; Linux: the Secret Service keyring, never a plaintext file) and leave the device only in memory, to the SSH library.
- A host-key mismatch fails loudly and is never retried.
- The APNs signing key can never sit on a self-hosted host — the relay only routes ciphertext it cannot read (see the push section).

## Conventions & gotchas

- **Comments: minimal.** Only a non-obvious "why" or a gotcha. Never restate the code.
- Tests are colocated (`foo.swift` + `foo.test`-style targets in TetherKit; `_test.go` in Go). New logic ships with tests. Keep pure logic testable without a live host — **live SSH tests are DEBUG-env-gated and skip in CI.**

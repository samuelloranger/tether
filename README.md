<p align="center">
  <img src="icon.png" width="96" alt="Tether icon" />
</p>

<h1 align="center">Tether</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/samuelloranger/tether" alt="License: GPL-3.0" /></a>
  <a href="https://github.com/samuelloranger/tether/actions/workflows/ci.yml"><img src="https://github.com/samuelloranger/tether/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/platform-iOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform: iOS | Windows | Linux" />
</p>

A native terminal for your own machines, on iOS, Windows and Linux. Tether connects over **SSH** to [`zmx`](#the-host-side) — a persistent session manager on the host — attaches a session, and renders the live shell. Because zmx owns the sessions on the host, they keep running when you close the app, lose signal, or reboot the phone or PC. Tether is a pure client: **no server to run, nothing exposed but SSH.**

> **v5 rewrite.** Earlier Tether ran a Bun server with a custom Noise transport plus desktop and web clients. v5 drops all of it for native apps over SSH: iOS, and a desktop client for Windows and Linux. The only host-side piece is `tether-notify`, a tiny tool for push.

## What you get

- **Persistent sessions** — the shell lives in `zmx` on the host. Disconnect, background the app, reboot the phone: the session (and whatever runs in it) is still there when you reattach.
- **A real terminal** — full VT emulator (TUIs, box drawing, CJK / emoji) on SwiftTerm, rendered natively. Live session switching, per-session working directory, scrollback history you can select and copy.
- **On-device key vault** — generate ed25519 keys in the Keychain, import or paste existing ones, see each key's SSH randomart and fingerprint. Private halves never leave the device except in memory, to libssh2.
- **Trust on first use** — an unknown host key is pinned on first connect; a later change is refused.
- **Built in** — git diff of the session's working directory, send a file or photo (SCP), kill a session, and encrypted push when an agent needs you.

## Install (iOS)

The app is built from source and installed to your device (there is no public distribution). You need a Mac with Xcode 26 or later.

```bash
xcodebuild build \
  -project clients/apple/Tether.xcodeproj \
  -scheme TetherIOS \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug \
  -skipPackagePluginValidation \
  CODE_SIGNING_ALLOWED=NO
```

See [`clients/apple/README.md`](clients/apple/README.md) for signing and on-device install.

## Install (Windows)

**[Download the installer](https://github.com/samuelloranger/tether/releases?q=desktop-v&expanded=true)** — take `Tether-<version>-x64-Setup.exe` from the newest `desktop-v*` release. It installs per user (no admin) and the app updates itself from then on. `Tether-<version>-x64-portable.zip` runs without installing but does not update. Neither is code-signed yet, so SmartScreen may warn on first launch.

Windows 10 22H2 or Windows 11, x64. One window, one tab per zmx session; on top of what the iOS app does it adds find in scrollback, `~/.ssh/config` import, ProxyJump ("Connect through"), Pageant, a git panel with pull requests, a markdown viewer, inline images (kitty, iTerm2), session history and a snippet palette. Build from source with Rust stable: `cargo build --release -p tether-app` in `clients/desktop/` (see [`clients/desktop/SPEC.md`](clients/desktop/SPEC.md)).

## Install (Linux)

Take `Tether-<version>-x86_64.AppImage` from the newest [`desktop-v*` release](https://github.com/samuelloranger/tether/releases?q=desktop-v&expanded=true), then:

```sh
chmod +x Tether-<version>-x86_64.AppImage
./Tether-<version>-x86_64.AppImage
```

The app updates itself in place: it checks the `linux-feed` release at launch, downloads a newer AppImage in the background and swaps the file on the next launch or from **Settings → About → Restart**. Keep the file somewhere you can write to. Downloads go to a private folder under `~/.cache/tether/updates`. Running it directly needs FUSE 2 (`libfuse2`); without it, run `./Tether-<version>-x86_64.AppImage --appimage-extract-and-run`, which updates the same way and still replaces the original file.

x86_64, glibc 2.35 or newer, X11 or Wayland. Saved passwords and key passphrases live in the desktop's Secret Service keyring (GNOME Keyring, KWallet), which must be running; agent authentication needs `SSH_AUTH_SOCK` set in the session. Build from source with `cargo build --release -p tether-app` in `clients/desktop/` after installing `libfontconfig1-dev` and `pkg-config`; `clients/desktop/packaging/linux/package.sh` builds the AppImage.

On first launch: add a machine (host, port, user, and a key from the vault), then open it. The app attaches an existing zmx session if the host has one, otherwise it starts `default`.

## The host side

Each host needs `zmx` (the session manager the app attaches to) and — optionally, for push — `tether-notify`.

**Push (`tether-notify`).** A phone registers its APNs token and a per-device AES key (generated on the phone, sent over SSH) and `tether-notify` encrypts each notification to that key, posting only ciphertext to a shared relay. The relay and Apple never see the plaintext; the iOS Notification Service Extension decrypts it on arrival.

```bash
bash install.sh                    # build + install tether-notify to ~/.local/bin (needs Go)
bash scripts/install-agent-hooks.sh homelab   # notify from agent hooks (waiting / done)
```

The app registers your phone automatically the next time it connects. Then any tool — a coding agent's hooks, a long job — can raise a notification:

```bash
tether-notify notify --title "homelab · agent" --body "Waiting for input" \
  --link "tether://session/default?host=homelab"
```

Agent hooks also record each session's state (`working`, `waiting`, `done`) with
`tether-notify state`; the app reads it with `tether-notify status` to badge sessions.
A `waiting`/`done` push is skipped while any zmx client is attached to that session —
including a desktop terminal. The app detaches 15 s after it goes to the background, so
a locked phone gets its pushes. As a backstop for an app killed while attached, set
`ClientAliveInterval 30` / `ClientAliveCountMax 2` in the host's `sshd_config`.

## Layout

```
clients/apple/        native iOS app (TetherKit package + TetherIOS + NSE)
clients/desktop/      native Windows and Linux app (Rust + Slint workspace)
apps/tether-notify/   Go host CLI for encrypted push
install.sh            build + install tether-notify
scripts/              install-agent-hooks.sh, release.sh
```

Architecture, data flow, and conventions: [`CLAUDE.md`](CLAUDE.md).

## Security

Transport is SSH — there is no shared password and no setup flow that skips host-key verification. Keys live in the iOS Keychain (or DPAPI-protected storage on Windows) and reach the SSH library in memory only. A host-key mismatch fails loudly. The push relay only ever routes ciphertext it cannot read. Keep hosts reachable over your LAN, a tunnel, or plain SSH as you already do.

## License

[GPL-3.0](./LICENSE)

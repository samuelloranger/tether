<p align="center">
  <img src="icon.png" width="96" alt="Tether icon" />
</p>

<h1 align="center">Tether</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/samuelloranger/tether" alt="License: GPL-3.0" /></a>
  <a href="https://github.com/samuelloranger/tether/actions/workflows/ci.yml"><img src="https://github.com/samuelloranger/tether/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/platform-iOS-blue" alt="Platform: iOS" />
</p>

A native iOS terminal for your own machines. Tether connects over **SSH** to [`zmx`](#the-host-side) — a persistent session manager on the host — attaches a session, and renders the live shell. Because zmx owns the sessions on the host, they keep running when you close the app, lose signal, or reboot the phone. Tether is a pure client: **no server to run, nothing exposed but SSH.**

> **v5 rewrite.** Earlier Tether ran a Bun server with a custom Noise transport plus desktop and web clients. v5 drops all of it for a single native iOS app over SSH. The only host-side piece is `tether-notify`, a tiny tool for push.

## What you get

- **Persistent sessions** — the shell lives in `zmx` on the host. Disconnect, background the app, reboot the phone: the session (and whatever runs in it) is still there when you reattach.
- **A real terminal** — full VT emulator (TUIs, box drawing, CJK / emoji), rendered from a Rust grid engine. Live session switching, per-session working directory, scrollback history you can select and copy.
- **On-device key vault** — generate ed25519 keys in the Keychain, import or paste existing ones, see each key's SSH randomart and fingerprint. Private halves never leave the device except in memory, to libssh2.
- **Trust on first use** — an unknown host key is pinned on first connect; a later change is refused.
- **Built in** — git diff of the session's working directory, send a file or photo (SCP), kill a session, and encrypted push when an agent needs you.

## Install (iOS)

The app is built from source and installed to your device (there is no public distribution). You need a Mac with Xcode.

```bash
xcodebuild build \
  -project clients/apple/Tether.xcodeproj \
  -scheme TetherIOS \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO
```

See [`clients/apple/README.md`](clients/apple/README.md) for signing and on-device install.

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

## Layout

```
clients/apple/        native iOS app (TetherKit package + TetherIOS + NSE)
apps/tether-notify/   Go host CLI for encrypted push
scripts/              install.sh, install-agent-hooks.sh, release.sh
```

Architecture, data flow, and conventions: [`CLAUDE.md`](CLAUDE.md).

## Security

Transport is SSH — there is no shared password and no setup flow that skips host-key verification. Keys live in the iOS Keychain and reach libssh2 in memory only. A host-key mismatch fails loudly. The push relay only ever routes ciphertext it cannot read. Keep hosts reachable over your LAN, a tunnel, or plain SSH as you already do.

## License

[GPL-3.0](./LICENSE)

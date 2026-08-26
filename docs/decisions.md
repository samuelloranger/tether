# Decisions

Why Tether is built the way it is.

## Single-binary server

The server ships as a `bun build --compile` binary that is both the daemon and the CLI. It removes bun/git/rsync/node_modules from the deployed box, makes `tether update` an atomic single-file swap, and can't leave a half-updated install.

## Shared password, and TLS the server terminates itself

Auth is a shared password on every request and on the WebSocket upgrade. Since then the server also terminates TLS: it generates a self-signed P-256 certificate on first boot and serves HTTPS/WSS alongside plaintext, and clients pin the certificate's fingerprint on first contact. Plaintext stays open by default so an update strands nobody; closing it is the operator's deliberate cutover, set in the host's environment rather than by any client — a phone that could close the plaintext port would lock out every other client on the network.

A self-signed certificate makes an *unpinned* first contact MITM-able, so a tunnel (Tailscale/WireGuard/SSH) or a trusted LAN is still the right place to pair. See [Security & networking](/security).

## Native clients over a shared Rust core

The clients are native — Swift/SwiftUI on iOS, Tauri on Linux/Windows/macOS — and both are built on one Rust core (`crates/tether-core`) that owns host profiles, connection health, the session socket and its replay cursor, and the git and workspace requests. That is a deliberate replacement for the previous arrangement, where one Expo codebase served phones and, through `react-native-web`, the desktop: shared *UI* meant every platform inherited the compromises of the others, while shared *logic* leaves each platform free to render and handle input the way it should.

A phone is where "my shell dropped when the screen locked" actually hurts, and a native app gives a real key layer and background-survival story a browser can't. There's no in-browser client because a browser can't attach the shared secret to the WebSocket upgrade.

Android was dropped rather than kept half-alive: it had no signing key of its own, so its APK could never offer authenticity or trusted in-place updates.

## Dark-first, themeable

Tether is a terminal, so it defaults to a dark, near-black identity rather than chasing a light/dark split. Since v1.7 the app ships Catppuccin themes so you can retune the palette without abandoning that dark-first stance.

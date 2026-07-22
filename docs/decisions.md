# Decisions

Why Tether is built the way it is.

## Single-binary server

The server ships as a `bun build --compile` binary that is both the daemon and the CLI. It removes bun/git/rsync/node_modules from the deployed box, makes `tether update` an atomic single-file swap, and can't leave a half-updated install.

## Shared password + tunnel, not built-in TLS

Auth is a shared password on every request. Encryption is delegated to a tunnel (Tailscale/WireGuard/SSH) rather than terminating TLS in the server: self-signed certs plus WebSocket on iOS are fragile, and self-hosters typically already run a tunnel. The app never claims the password encrypts traffic.

## Native clients, no browser client

The clients are native: the Expo app on iOS/Android and a Tauri desktop app (built from the same `apps/mobile` code) on Linux/Windows/macOS. A phone is where "my shell dropped when the screen locked" actually hurts, and a native app gives a real key layer and background-survival story a browser can't. There's no in-browser client because a browser can't attach the shared password to the WebSocket upgrade.

## Dark-first, themeable

Tether is a terminal, so it defaults to a dark, near-black identity rather than chasing a light/dark split. Since v1.7 the app ships Catppuccin themes so you can retune the palette without abandoning that dark-first stance.

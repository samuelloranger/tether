# Decisions

Why Tether is built the way it is.

## Single-binary server

The server ships as a `bun build --compile` binary that is both the daemon and the CLI. It removes bun/git/rsync/node_modules from the deployed box, makes `tether update` an atomic single-file swap, and can't leave a half-updated install.

## Shared password + tunnel, not built-in TLS

Auth is a shared password on every request. Encryption is delegated to a tunnel (Tailscale/WireGuard/SSH) rather than terminating TLS in the server: self-signed certs plus WebSocket on iOS are fragile, and self-hosters typically already run a tunnel. The app never claims the password encrypts traffic.

## Mobile-only, no web client

The client is the Expo app. A phone is where "my shell dropped when the screen locked" actually hurts, and a native app gives a real key layer and background-survival story a browser can't.

## Dark-only

Tether is a terminal. The UI commits to one dark, near-black identity rather than theming both ways.

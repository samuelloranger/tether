# Updating & data

## Updating

```sh
tether update
```

Downloads the latest release binary for your platform, verifies it, atomically swaps it in, and restarts the daemon if it was running. No reinstall, no git.

## The `tether` CLI

One binary is the whole CLI:

```
tether serve | start | stop | restart | status | logs | present | set-password | update | version
```

- `serve` (or no argument) runs the daemon in the foreground; `start` runs it detached.
- `present` opens or clears display-only HTML previews for coding agents. Run `tether present agent-install [codex|claude]` to install the optional global agent skills.
- pid + log live in `~/.tether/`.

## Data & environment

- Database (sessions + password) lives in `~/.tether/config/tether.db`.
- Environment: `TETHER_PORT` (default `8085`), `TETHER_DB_PATH` (override the DB path), `TETHER_REPO_SLUG` (update source, default `samuelloranger/tether`).

::: info macOS
Release binaries are unsigned. On first run macOS may need: `xattr -d com.apple.quarantine ~/.local/bin/tether`.
:::

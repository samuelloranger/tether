# Sessions & tabs

## Multiple terminals

Open the drawer (menu icon) to see every terminal on the server and switch between them. Each is an independent shell. Only the active one holds a live WebSocket; switching detaches the others (their shells keep running on the server) and reattaches instantly from a small cache.

## Persistence & replay

The whole point of Tether: **the shell survives disconnects and server restarts.** Each session's PTY lives in a detached *holder* process, and every byte of output is logged to SQLite. When you reconnect, the server replays everything since the last line your device saw — so you never miss output, even after your phone slept for hours.

## Destructive actions

- **Restart terminal** (overflow menu) — terminates and respawns the shell, and **clears that terminal's scrollback history**. Confirmed before it runs.
- **Kill** (drawer) — deletes the process **and its saved output**. Confirmed before it runs; can't be undone.

## Rename

Overflow menu → Rename terminal. Names are stored server-side and shown in the drawer.

# Sessions & tabs

## Multiple terminals

Open the drawer (menu icon on iOS; the left sidebar on desktop) to see every terminal, grouped by host if you've paired more than one. Each is an independent shell.

Sessions in the current layout — the active tab, plus every pane of a desktop split — keep a live socket and keep streaming in the background. Input and clipboard are gated to the focused pane. Switching away from a session that is no longer resident drops its socket (the shell keeps running on the server); coming back replays from the last line this device saw.

## Persistence & replay

The whole point of Tether: **the shell survives disconnects and server restarts.** Each session's PTY lives in a detached *holder* process, and every byte of output is logged to SQLite. When you reconnect, the server replays everything since the last line your device saw — so you never miss output, even after your phone slept for hours.

## Activity

Each session is classified `working`, `waiting` (blocked on you), `done` (a piece of work finished), or `idle`. The drawer shows a dot; on desktop the chrome tints to match the focused session, and a `waiting` row stays visible even when you aren't in that tab.

A coding agent can declare the state itself instead of letting Tether guess from the byte stream:

```sh
tether signal working          # a turn started
tether signal waiting          # blocked on a question or permission
tether signal done             # the turn finished
tether signal hooks            # print the Claude Code ~/.claude/settings.json snippet
```

`tether signal` only works from *inside* a Tether session (`TETHER_SESSION_ID` is exported into every one). After the first signal the session is *agent-driven*: heuristics stop, duplicate OSC pushes are suppressed, and a full-screen redraw no longer knocks it back to `working`. `tether signal hooks` wires `UserPromptSubmit` → `working`, `Notification` → `waiting`, `Stop` → `done`.

`waiting` is the only state that is allowed to pull attention away from the tab you're in. A keystroke always answers a `waiting`.

## Destructive actions

- **Restart terminal** (overflow menu) — terminates and respawns the shell, and **clears that terminal's scrollback history**. Confirmed before it runs.
- **Kill** (drawer) — deletes the process **and its saved output**. Confirmed before it runs; can't be undone. Killing a desktop group asks about every member.

## Rename

Overflow menu → Rename terminal. Names are stored server-side and shown in the drawer.

# Session signals

Every tether session carries a state — `working`, `waiting`, `done` or `idle` —
that drives tab colour and push notifications. The server infers it from the PTY
byte stream, and a program can override that guesswork by declaring its own.

## The four states

| State | Meaning |
|---|---|
| `working` | The session is busy. |
| `waiting` | **Blocked.** The only state allowed to pull attention away from the active tab. |
| `done` | A piece of work finished. Its own colour, its own notification trigger, off by default. |
| `idle` | Nothing happening. |

`apps/server/src/pty/activity.ts` classifies each session from its output.

## Declaring state explicitly

`tether signal <working|waiting|done>` overrides the heuristics.
`TETHER_SESSION_ID` is exported into every session, and the CLI posts to
`/control/signal` with the present-control token.

A session that has signalled becomes **agent-driven**:

- The byte heuristics stop guessing for it.
- Its duplicate OSC push is suppressed.
- Plain output no longer drags it back to `working`. A full-screen agent redraws
  constantly, including right after its own "finished" signal, so without this
  latch the redraw would immediately undo the signal.

The latch holds until a shell prompt releases it.

## Claude Code hooks

`tether signal hooks` prints the configuration. It wires three hooks:

| Hook | Signal |
|---|---|
| `UserPromptSubmit` | `working` |
| `Notification` | `waiting` |
| `Stop` | `done` |

## Why a keystroke is never gated

A keystroke always answers a `waiting`. That path is never gated — otherwise a
blocked tab would have no exit.

A keystroke also ends a `done`, but only until the session declares `working` for
itself once. After that the declaration is trusted and composing a message no
longer marks the tab busy. That fallback exists for configurations written before
`UserPromptSubmit` was part of the snippet.

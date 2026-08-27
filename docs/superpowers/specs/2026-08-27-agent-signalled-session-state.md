# Spec: Agent-signalled session state — separating "finished" from "needs attention"

**Status:** proposed · **Board:** #881 · **Date:** 2026-08-27

## Problem

`sessionActivity.ts` classifies every session as `working` / `waiting` / `idle`.
`waiting` is the app's "needs attention" state: it turns the drawer dot red, tints
the whole chrome ember, fires the one authored motion moment, and sends a push.

`waiting` currently means two different things and the server cannot tell them
apart. A Claude Code turn that merely **finished** produces the same signal as one
that is **blocked on a permission prompt**, so a routine completion pulls the same
alarm as a real question.

## Evidence

Gathered 2026-08-27 from the live `~/.tether/config/tether.db` and the two running
sessions on this host.

1. **One OSC, two meanings.** `~/.claude/settings.json` sets
   `"preferredNotifChannel": "ghostty"`, so Claude Code emits `OSC 777;notify`
   both when it needs permission and when its turn ends.
   `recordOutputEvent` maps *any* notify to `waiting` plus a push
   (`sessionActivity.ts`, `ptyHolder.ts:220`).

2. **`waiting` is sticky.** `getActivity()` runs its silence heuristics only
   `if (st.activity === 'working')`. Once a bell or notify latches `waiting`,
   nothing clears it but fresh visible output, an OSC 133 mark, or a keystroke.
   A finished, quiet session stays "needs attention" indefinitely.

3. **The escape hatches never fire in real sessions.** Mining the retained
   `terminal_logs`: the only OSC code present anywhere is `0` (title). Zero
   OSC 133. The injected PS1 (`~/.tether/config/tether.bashrc`) emits OSC 7 but
   no prompt marks. Replaying both live sessions through `scanChunk` gives tails
   `"⏵⏵bypasspermissionson (shift+tabtocycle)·←6agents"` and
   `"~/sites/tether · chore/decommission-rn-mobile"` — neither `WAITING_RE` nor
   `PROMPT_RE` matches. Both regexes are shaped for line-oriented CLIs, not
   full-screen TUIs that redraw a box.

4. **Any bare BEL counts as attention.** Tab-completion beeps, readline errors,
   and `printf '\a'` in a script all latch `waiting`.

## Approach

Three changes, in dependency order.

### 1. Let the program say which it is

The guesswork is unwinnable from bytes alone, and the information already exists
one process up. `TETHER_SESSION_ID` is exported into every session
(`pty.ts:70`), and there is already a loopback control channel authed by
`~/.tether/present-control-token` (`routes/presentations.ts`). Add:

- `POST /control/signal` — `{ sessionId, state, title?, body? }`
- `tether signal <working|waiting|done> [--title X] [--body Y]`
- `tether signal hooks` — prints the Claude Code hook JSON to paste into
  `settings.json`, mapping the two *distinct* hook events:
  `Notification` → `waiting`, `Stop` → `done`.

A session that has signalled once is **agent-driven**: the byte heuristics stop
guessing for it, and a bell or OSC notify no longer forces `waiting`. The agent
is a better authority than a regex, and mixing the two produces flapping.

**Suppressing the duplicate OSC push is the load-bearing half of this.** The push
a finished Claude turn raises today is not a `waiting` push — `flushHolderOutput`
checks the notify payload first, so it is an `oscNotify`, and `triggers.oscNotify`
defaults on. Splitting the state without dropping that payload for an
agent-driven session would leave the buzz exactly as it is and change only the
colour of the dot.

The latch is not permanent. A bare shell prompt is the one unambiguous sign that
whatever was running has exited, so reaching one releases it — otherwise quitting
Claude Code would leave the session exempt from the heuristics for the rest of
its life.

### 2. Split the state

`Activity` becomes `'working' | 'waiting' | 'done' | 'idle'`.

| state | means | chrome |
|---|---|---|
| `working` | a program is producing output | amber |
| `waiting` | **blocked** — cannot proceed without an answer | ember, swell, push |
| `done` | finished a piece of work; output is worth a look | green, no swell, push off by default |
| `idle` | a bare shell prompt, nothing has happened | cool blue |

`done` is not `idle`: `idle` is "nothing happened", `done` is "something
completed". They deserve different colour and different notification defaults.

`config.triggers` gains `done`, defaulting to **false** — the whole point is to
stop the spurious ping, so opting in is the user's choice.

### 3. Make heuristic `waiting` decay

Track where a `waiting` came from (`signal` / `osc` / `tail`). For an
`osc`-sourced `waiting` only, run the silence heuristics from that state too: if
the session has been silent for `silenceMs` and the tail does *not* look like a
question, settle to `done` instead of staying lit forever. Signal-sourced
`waiting` never decays — the agent said it is blocked, and only the agent or a
keystroke may say otherwise.

## Non-goals

- Parsing Claude Code's TUI to recognise its choice box. Brittle, and (1) makes
  it unnecessary.
- Adding OSC 133 prompt marks to the injected PS1. A real improvement for bare
  shells, tracked separately — it does nothing for the agent case that motivates
  this work.
- Touching `apps/mobile`. Retired; do not edit.

## Compatibility

- Protobuf `Activity` gains `ACTIVITY_DONE = 4`. An older client does not drop
  the frame — protobuf-es decodes the unknown value as its raw number and
  `decodeActivityFrame` resolves it to `null` through a `Partial<Record<>>`
  lookup. The 4-second `/api/sessions` poll still delivers `activity: "done"` as
  a JSON string, and every client's classifier has a default arm that degrades
  it to working/idle. No hard break.
- `config.triggers.done` must be **optional on input everywhere**, and for three
  different reasons. On the server, `readTopLevel` discards the entire `triggers`
  section on a parse failure, so a required key would silently reset a user's
  other choices at upgrade — hence `z.boolean().default(false)`. On iOS, Swift's
  synthesised `Codable` throws on a missing key, so it needs a custom
  `init(from:)` using `decodeIfPresent`. In Rust, `#[serde(default)]`.
- `/control/signal` reuses the existing control token and, like
  `/control/presentations`, is reachable on every bound interface rather than
  loopback only. Same exposure as the existing control surface; not widened.

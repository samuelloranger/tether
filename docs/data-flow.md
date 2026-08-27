# Data flow

The core loop, from key press to pixels and back.

## Connect & replay

1. The client opens `GET /api/ws?sessionId=&sinceId=&cols=&rows=` with `Authorization: Bearer <token>`.
2. The server ensures the session's holder is running (spawns or reattaches), then **replays** every log row after `sinceId` from SQLite to catch the client up.
3. It subscribes the client to live output.

## Live output

`PTY chunk → holder → server → addTerminalLog (SQLite, returns row id) → broadcast to subscribers`. The client stores the latest row id it has seen; on reconnect it sends that as `sinceId`, so only missed output is replayed.

## Session activity

Every output chunk is also scanned for what the foreground program is *doing*:
`working`, `waiting` (blocked on an answer), `done` (finished a piece of work),
or `idle` (a bare shell prompt). Transitions are broadcast as an `activity`
frame and reported by `GET /api/sessions`.

A bell or an OSC 9/777 notification is only a guess — agents emit the same
sequence on completion as on a question — so a `waiting` that came from one
decays to `done` after `silenceMs` of quiet if the screen is not actually asking
anything. That decay happens lazily on the session-list read, so an attached
client sees it on its next poll rather than as a frame.

A program can skip the guessing entirely: `tether signal <state>` posts to
`/control/signal` and the session becomes *agent-driven*, which disables the
heuristics, suppresses its now-duplicate OSC push, and stops plain output from
overriding the state the program declared — a full-screen agent redraws its
interface constantly, so otherwise a single frame would undo the `done` it just
signalled. The latch holds until the session reaches a shell prompt. Because
nothing else moves an agent-driven session, the program must also signal
`working` when it starts a turn; `tether signal hooks` wires all three.

## Holder protocol

Server ↔ holder speak newline-delimited JSON over a unix socket, base64 payloads for binary safety:

- server → holder: `{t:'i', d}` (input), `{t:'r', c, r}` (resize), `{t:'k'}` (kill)
- holder → server: `{t:'o', d}` (output), `{t:'x', code}` (exit)

## Pruning

`terminal_logs` is capped (~2000 rows/session). When rows are pruned, a watermark records it; if a reconnecting client's `sinceId` predates the prune, the server tells it to reset the emulator before the replay so there's no hole.

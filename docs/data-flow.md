# Data flow

The core loop, from key press to pixels and back.

## Connect & replay

Shipping clients stream over **Noise**, not a bearer-authed `/api/ws`:

1. The client reconnects with an IK handshake to `GET /api/noise/session`. The handshake *is* the authentication — there is no `Authorization` header on that socket.
2. Over the sealed channel the client sends `{t:'start', id, cols, rows, sinceId?}`. The server ensures the session's holder is running (spawns or reattaches), then **replays** every log row after `sinceId` from SQLite, then streams live.
3. REST (`/api/sessions`, git, files, config, …) still uses `Authorization: Bearer <token>`. The client mints that token over the same Noise channel (`{t:'auth.token'}`) and caches it.

`GET /api/ws?sessionId=&sinceId=&cols=&rows=` still exists as a bearer-authed JSON WebSocket (`proto=1`, with an optional binary `proto=2`). Native clients do not use it.

## Live output

`PTY chunk → holder → server → addTerminalLog (SQLite, returns row id) → broadcast to subscribers`. The client stores the latest row id it has seen; on reconnect it sends that as `sinceId`, so only missed output is replayed.

Clients keep `sinceId` **in memory**. An app restart, an LRU eviction, or a server-sent `reset` drops it, and the next connect replays the retained tail. Replay itself is byte-budgeted: if the missed span is larger than the budget, the server sends `reset` and the newest suffix rather than the whole hole.

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

Server ↔ holder speak length-prefixed binary frames over a unix socket (raw PTY
bytes for output, no base64). The holder sends `HELLO` on attach so a
reattaching server knows the dialect; a pre-v2 server ignoring that line is
harmless. Kinds:

- server → holder: input, resize, kill, cwd-request
- holder → server: hello, output, exit, cwd

## Pruning

`terminal_logs` is capped (~2000 rows/session, plus a byte cap). When rows are pruned, a watermark records it; if a reconnecting client's `sinceId` predates the prune, the server tells it to reset the emulator before the replay so there's no hole.

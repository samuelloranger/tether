# Data flow

The core loop, from key press to pixels and back.

## Connect & replay

1. The client opens `GET /api/ws?sessionId=&sinceId=&cols=&rows=` with the password header.
2. The server ensures the session's holder is running (spawns or reattaches), then **replays** every log row after `sinceId` from SQLite to catch the client up.
3. It subscribes the client to live output.

## Live output

`PTY chunk → holder → server → addTerminalLog (SQLite, returns row id) → broadcast to subscribers`. The client stores the latest row id it has seen; on reconnect it sends that as `sinceId`, so only missed output is replayed.

## Holder protocol

Server ↔ holder speak newline-delimited JSON over a unix socket, base64 payloads for binary safety:

- server → holder: `{t:'i', d}` (input), `{t:'r', c, r}` (resize), `{t:'k'}` (kill)
- holder → server: `{t:'o', d}` (output), `{t:'x', code}` (exit)

## Pruning

`terminal_logs` is capped (~2000 rows/session). When rows are pruned, a watermark records it; if a reconnecting client's `sinceId` predates the prune, the server tells it to reset the emulator before the replay so there's no hole.

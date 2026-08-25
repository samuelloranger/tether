# tether-core P0 Spike — Findings and Go/No-Go

**Date:** 2026-08-25
**Plan:** `docs/superpowers/plans/2026-08-25-tether-core-p0-spike.md`
**Spec:** `docs/superpowers/specs/2026-08-25-native-client-rewrite-design.md`
**Branch:** `feat/tether-core-p0` (9 commits from cursor-agent, 1644 insertions)

## Verdict: GO

The core boundary works. The claim P0 existed to test — *can `tether-core` own the
replay cursor in Rust and drive the existing xterm.js WebView with no UI change* — is
verified end to end against a real server and a real PTY, not inferred from unit tests.

## Test environment

Deliberately isolated from production on both sides, because this host runs the live
daemon:

| Layer | Production (untouched) | Test |
|---|---|---|
| Server | `:8085`, `~/.tether/config/tether.db` | `:8095`, repo-local `apps/server/config/tether.db` |
| Holder sockets | `~/.tether/config/holders/` | repo-local `apps/server/config/holders/` |
| Client profile | real `~/.local/share` | scratch `XDG_DATA_HOME` |

`paths.ts` makes the server side free: a non-compiled run puts the DB *and* holder
sockets in the repo, so `bun dev:server` cannot see the live DB or adopt a live holder.
Only a non-default `TETHER_PORT` was needed.

**A near-miss worth recording.** The first `tauri dev` launch inherited a saved host
profile pointing at the *production* daemon and immediately rendered the live session
this work was being done from. Driving the test there would have run untested transport
code against the live server, required killing the real daemon for the replay step, and
had `xdotool` typing into the very shell driving the test. The fix was isolating the
client's `XDG_*` dirs so it starts with no host profile. **Any future GUI test of this
app must isolate the client profile, not just the server.**

## Results

| Assertion | Result | Evidence |
|---|---|---|
| Core transport actually used | **PASS** | 6 × `core_connect`, 0 × `ws_connect` |
| Render/input parity vs `ws_*` baseline | **PASS** | Identical output, keyboard, title/cwd |
| Survives server kill + restart | **PASS** | Stream reached `STREAM_DONE` across a ~9 s outage |
| Replay: no duplicate, no gap | **PASS** | `MARK-1`…`MARK-50` once each, client == server log |
| Heavy output | **PASS** | 4 MB and 9 MB of base64 rendered without stall |
| `reset` on over-budget replay | **PASS** | Server trimmed and sent `reset`; terminal usable after |

### The reset test

Flooded to 2,049,439 retained bytes against the 2,000,000 `REPLAY_BYTE_BUDGET`, then
restarted only the client so its cursor returned to 0:

```
WebSocket opened for session "term-3" since log ID: 0
Streaming 14 missed logs (1997043 bytes) to client... [trimmed to byte budget, sent reset]
```

The client cleared and rendered a coherent tail; a subsequent `echo POST_RESET_OK; date`
ran and displayed correctly, so the emulator was left in a good state rather than a
corrupted one.

Incidental confirmation from the line just above it in the same log: the pre-restart
client reconnected at `since log ID: 121075` with `Streaming 0 missed logs` — the Rust
cursor was genuinely tracking a live position, not sitting at zero.

### Proving the transport was live

Both transports produce a working terminal, so a working terminal proves nothing about
*which* ran. Temporary `eprintln!` markers were added to both `core_connect` and
`ws_connect`, and the log showed:

```
P0MARKER core_connect session=term-3 cols=217 rows=79
```

with `ws_connect` never firing across 6 connects including every reconnect. The markers
were reverted afterwards; the branch is exactly what cursor-agent produced.

### The replay test — the one that mattered

`MARK-1`…`MARK-50` at 2/sec; dev server killed ~6 s in, restarted 6 s later. The client
rendered all 50 marks in order, each exactly once, then `STREAM_DONE`. Cross-checked
against the server's own `/api/sessions/:id/logs`: 50 hits, 50 distinct, no duplicates,
no missing. Client and server agree exactly, with the cursor owned by Rust.

## Corrections to the plan (my errors, not the code's)

1. **The plan says to flip the flag via devtools. That does not work here.**
   `ctrl+shift+i` opens a 1×1 window in this Tauri/GTK dev build. The working method is
   writing the key into the webview's localStorage SQLite while the app is closed:
   `sqlite3 <XDG_DATA_HOME>/cloud.samlo.tether/localstorage/http_127.0.0.1_1430.localstorage
   "INSERT INTO ItemTable (key,value) VALUES ('tether.coreTransport', X'3100');"`
   Values are **UTF-16LE blobs** — the string `'1'` will not work, it must be `X'3100'`.

2. **`tauri dev` hot-rebuilds on Rust edits and restarts the app**, wiping the
   in-process replay cursor. Any cursor-dependent test must run with the tree frozen.
   This invalidated one reset run mid-flight.

3. **Three reset-test designs failed before the volumes and the topology were right.**
   Recorded so nobody repeats them:
   - 40 000 short `echo`s produced only **1741 rows / 491 KB** — chunks coalesce, so
     that cleared neither the ~2000-row prune cap nor the 2 MB replay budget.
   - Killing the *server* to create the gap does not work: nothing is recording while it
     is down, and the connected client's cursor is already current, so the reconnect
     reports `Streaming 0 missed logs`.
   - The correct shape is: flood with **server and client both up** so rows land in the
     DB, then restart **only the client**, whose cursor resets to 0 and forces a replay
     of the whole retained tail.

4. A harness bug voided the first replay run: `echo "L\$i"` inside a quoted heredoc
   typed a literal `\$i`, so 60 identical lines were printed — useless for detecting
   gaps. Rerun with real numbering is what the PASS above rests on.

## Findings that change the design

**Client restart resets every cursor to 0.** The `ReplayStore` lives in the Tauri
process, so restarting the client loses all cursors and the next connect replays the
retained tail. This is invisible today because TypeScript also held `sinceId` in memory —
but P2 moves cursor ownership into the core *permanently*, and P1's opaque cursor makes
it a first-class protocol object. **Decision needed, currently unwritten: does the core
persist cursors across restarts?** If yes, `tether-core` needs a storage seam (which iOS
will need anyway for its own reasons) and the spec should say so.

**Pinning a fingerprint read over plaintext pins the attacker.** Surfaced by the P1 TLS
work, not this spike, but it lands on the core: the fingerprint is advertised on the
plaintext listener too, because clients need it to discover the https port. `secure:
false` is the guardrail, and it only holds if `tether-core` *enforces* it rather than
treating it as convention. That belongs in the spec as a core assertion.

**Unrelated pre-existing issue, worth a ticket:** `app.ts:47` derives the rate-limit key
from `X-Forwarded-For` / `X-Real-IP`, which a direct caller can spoof to evade the
password rate limiter.

## Friction at the boundary

Low. Three observations for P2:

- **Verbatim frame forwarding was the right call.** Parsing only to *decide* (drop a
  duplicate `output`, rewind on `reset`) and forwarding the original text meant zero
  WebView changes and byte-exact `diff`/`status` passthrough without modelling those
  payloads.
- **The `splitSocketUrl` shim is the one ugly part** — the core wants origin + params
  while every caller still builds a full URL. Fine as a spike; P3 should push the split
  up into `hostClient.openSocket` and delete it.
- **`SessionConfig`/`CoreEvent` needed no revision** during the work, which is mild
  evidence the boundary is at the right altitude.

## Recommendation

**Proceed to P1–P5**, with two spec amendments before P2 starts: settle cursor
persistence across client restarts, and make plaintext-fingerprint rejection a core
assertion rather than a convention.

Note that P1 was built in parallel with this spike rather than after it, at the user's
explicit direction and with the gate risk stated. That risk did not materialise — the
boundary held, so no P1 rework is implied by this verdict.

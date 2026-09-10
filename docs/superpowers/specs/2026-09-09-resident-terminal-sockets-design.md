# Resident terminal sockets (zero-replay tab switch)

**Date:** 2026-09-09
**Status:** Design approved, pending implementation plan
**Related:** board #1149 (persistence fix, merged as PR #172), board #731 (sinceId churn)

## Problem

Switching to a terminal tab replays output the client already showed once, or
replays the whole retained tail. PR #172 fixed two of three causes:

1. Desktop forgot the replay cursor on every unmount — fixed (retention on
   switch).
2. Cursors were memory-only — fixed (`FileCursorPersistence` wired into both
   clients).

The **third** cause remains: a client keeps a live socket only for the
*currently visible* session(s). A tab switched away drops its socket; while it
is disconnected the PTY keeps producing output, so on return the client
reconnects and replays the delta. For a **busy** background tab that delta can
exceed the 2 MB replay byte budget (`REPLAY_BYTE_BUDGET`) or outrun the prune
watermark (`LOG_CAP = 2000`), forcing a full `reset` + repaint — a full replay
regardless of retention size, because replay is byte-capped.

The only way to eliminate replay for a busy foreground tab is to **never drop
its socket**: keep it streaming in the background so its cursor never falls
behind.

## Goal

While the app is foregrounded, switching between tabs causes **zero replay** on
both desktop and iOS. Non-visible tabs keep a live socket (up to a cap) and
stream in the background; only input, focus, paste, and clipboard remain gated
to the active tab.

Out of scope: streaming while the iOS app is *backgrounded* — the OS suspends
the process, so sockets drop regardless. Persistence (already shipped) replays
the delta once on the next foreground. This design does not change that.

## Non-goals

- No server change. The server already accepts N concurrent Noise sessions per
  device; residency is purely a client concern.
- No change to the input/focus/paste gate (active tab only).
- No change to iOS background behavior beyond reconnecting the resident set on
  return to foreground.

## Parameters (approved)

- **Resident cap:** LRU, **8** most-recently-active sessions. Visible panes
  always count toward (and never get evicted from) the resident set.
- **Host scope:** all connected hosts. A down host's background sockets fail
  gracefully and its sessions fall back to reconnect+replay.
- **Beyond the cap:** evicted sessions drop their socket and rely on the merged
  persistence + incremental-replay path (cursor persisted → small delta on
  return, not a full tail).

## Desktop design

### Current shape

`ResidentTerminals` renders one `TerminalPane` per **visible pane leaf**
(`layout.leaves`). Each `TerminalPane` owns its socket via `bindTerminalSession`
and mounts/unmounts on `props.sessionId` change. A session not in the pane tree
has no `TerminalPane` and no socket. Switching a pane's session swaps
`sessionId` → remount → socket drop → replay.

### Change

Render **one `TerminalPane` per resident session, keyed by `sessionKey`** (not
by `paneId`). Position each instance:

- into its current pane's rect when the layout shows it, or
- **offscreen, hidden, `interactive=false`** when it is resident but not shown.

Keying by session is the crux: React preserves the instance across a tab move,
so the xterm scrollback and the socket survive. A tab switch becomes a
re-position of an already-mounted instance — no remount effect, no socket
teardown.

### Resident set

`residentSessions(drawerSessions, tree, lru, cap=8)` → the session keys that get
a mounted `TerminalPane`:

- always include every session currently in `tree` (visible panes),
- fill the remainder up to `cap` from the LRU of recently-active sessions across
  all connected hosts.

A pure function, unit-tested. `ResidentTerminals` maps its output to positioned
`TerminalPane`s; sessions dropping out of the set unmount (socket closes, cursor
kept unless the session also left the drawer — the existing `reconcileResidency`
still governs cursor-forget).

### Offscreen technique

Park hidden instances at a fixed offscreen position (not `display:none`, which
zeroes xterm geometry and breaks fit). Keep a real size (last-shown or default
80×24); on activation, move into the pane rect and refit (existing
`ResizeObserver` + `fitTerminal` path already handles this).

## iOS design

### Current shape

One `TerminalPipeline` actor owns one `noiseChannel` + one `currentGrid`
(emulator + buffer). `SessionStore` calls `connectTerminal(sessionId:)` /
`pipeline.release()` around `activeSessionId`. Switching tabs disconnects and
reconnects the single pipeline → replay. The VT read path already runs off the
main actor (a prior perf fix), so additional background parsers do not block the
UI.

### Change

`SessionStore` owns an **LRU dict of `TerminalPipeline`** (cap 8), keyed by
host-qualified session key.

- The **active** session's pipeline feeds the visible surface + receives
  input/focus/paste.
- **Background** pipelines keep their `noiseChannel` open and feed their
  emulator (advancing the replay cursor) but their snapshot stream has no UI
  consumer. To avoid needless rasterization, gate snapshot *production* when a
  pipeline has no attached surface.
- Switching = point the surface at the existing pipeline's snapshot stream — no
  `disconnect`/`sendStart`, no replay.

### Lifecycle

- `scenePhase` → **background/inactive:** close all resident sockets (OS
  suspends anyway); record intent so foreground knows to reconnect.
- `scenePhase` → **foreground/active:** reconnect the resident set, **staggered**
  (small backoff between sockets) to avoid a reconnect storm. Persistence covers
  the suspend gap (delta replay per session, once).
- **Eviction (LRU beyond 8):** disconnect + release the pipeline; cursor is
  persisted, so a later return replays only the delta.

## Data flow / invariants

- Input, focus, paste, clipboard: active tab only (unchanged gate).
- Every session with a live socket advances its own `sinceId` continuously, so a
  resident tab's cursor never falls behind → nothing to replay on switch.
- Server unchanged; N concurrent Noise sessions per device already supported.
- Eviction is always safe: cursor persisted, delta-replay path proven.

## Testing

- **Desktop:** pure-fn tests for `residentSessions` (LRU + visible-always-in +
  cap) and for offscreen-vs-pane positioning. Existing 251-test suite must stay
  green. Assert switching an active tab away + back does not fire a new socket
  `open`/`start` for the previously-active session.
- **iOS:** `SessionStore` pipeline-LRU unit tests (add/evict/reuse; visible
  never evicted). TetherKit sim tests on macbuild. Assert A→B→A reuses the
  existing pipeline (no `sendStart`).
- **Both:** the switch-back-keeps-socket assertion is the acceptance oracle.

## Risks / mitigations

- **iOS battery/CPU:** N=8 live parsers off-main. Bounded by the cap; gate
  background snapshot production so non-visible pipelines don't rasterize.
- **Foreground reconnect storm:** stagger resident reconnects with backoff.
- **Desktop socket count:** cap 8 + visible; a heavy user with many tabs keeps
  at most 8 background sockets, the rest fall back to persistence.
- **iOS refactor blast radius:** single-pipeline → dict-of-pipelines touches
  `SessionStore` connect/release/focus/kill paths. Mitigate by keeping
  `TerminalPipeline` itself unchanged (it is already single-session and
  self-contained) and moving only ownership/lifecycle into `SessionStore`.

## Rollout

Two PRs, desktop first then iOS, or one branch with both — decided at planning.
Each verified with its suite; iOS verified on macbuild (xcframework + TetherKit
sim tests) as with PR #172.

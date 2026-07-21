# Session Status Badges + AltStore-Compatible Notifications — Design Spec

Date: 2026-07-21
Status: draft (awaiting review)

## Problem

Tether's core use case is running long-lived agent sessions (Claude Code, Codex) remotely.
Today the user must open the app and eyeball each session to know whether an agent is
still working, finished, or blocked waiting for a y/n answer. There is no signal that a
session needs attention, so the user polls the phone manually.

Two sub-problems:

1. **State detection** — the server must classify each session as `working`,
   `waiting` (needs input), or `idle`, and expose that to clients.
2. **Notification delivery** — "agent needs you" must reach an iPhone even though the
   app is sideloaded via AltStore, which means **no APNs entitlement and no native
   remote push**. Delivery must not depend on an Apple developer account.

## Goals

- Per-session status badge in the mobile/desktop session drawer, updating live.
- Push-style notification to the phone when a session transitions to `waiting`
  (and optionally on `exit`), delivered without native APNs.
- Zero new mandatory infrastructure: everything optional, off by default,
  configured per device/user.

## Non-goals

- LLM-based summaries of missed output (separate feature).
- Quick-reply actions from the notification (future; both channels support it later).
- Multi-user accounts. Tether remains single-password, single-user.

## Part 1 — Session activity state

### States

| State | Meaning |
|---|---|
| `working` | Output flowing recently; foreground process busy |
| `waiting` | Interactive program is blocked on user input |
| `idle` | Shell prompt, no foreground job |
| `exited` | PTY gone (already exists as `exit` frame) |

### Detection signals (layered, strongest wins)

All detection lives server-side at the single output chokepoint (`pty.ts` broadcast
path), same placement as `liveCwd.recordChunk`. A new `sessionActivity.ts` module keeps
per-session state, mirroring the `liveCwd.ts` module shape (pure chunk-scanner function +
per-session Map + streaming-residual handling, unit-testable without a PTY).

1. **Explicit escape sequences (strong).**
   - **BEL (`\x07`) outside an OSC string** — Claude Code rings the terminal bell when it
     needs attention (permission prompt, idle notification). Bell while a non-shell
     foreground process is running ⇒ `waiting`.
   - **OSC 9 (iTerm2/ConEmu notification) and OSC 777;notify** — some tools emit these;
     parse payload as notification title/body ⇒ `waiting` with message.
   - **OSC 133 prompt marks (A/B/C/D)** — shell integration already partially present
     (OSC 7 wiring exists). `133;A` (prompt start) after command end ⇒ `idle`.
     `133;C` (command executing) ⇒ `working`.
2. **Foreground process inspection (medium).** The holder owns the shell PID. On Linux,
   read `/proc/<shell-pid>/stat` children / the PTY's foreground process group
   (`tcgetpgrp` equivalent via `/proc/<pid>/stat` field 8) on a slow poll (~5s, only for
   sessions in ambiguous state). fg pgid == shell pgid ⇒ `idle`; else a program is
   running. Reuses the `/proc` techniques already in `procIdentity.ts`/`procCwd.ts`.
   macOS fallback: `ps -o stat,tpgid`.
3. **Output-silence heuristic (weak, tie-breaker).** A non-shell foreground process that
   has produced no output for N seconds (default 15) **and** whose last visible line
   matches a prompt-ish pattern (`(y/n)`, `❯`, trailing `? `, numbered-menu regex,
   Claude Code's `Do you want` / `Esc to interrupt` absent) ⇒ `waiting`. Output resumes ⇒
   `working`.

The heuristic layer ships with a small, extensible pattern table; false positives are
acceptable because the badge is advisory and notifications are debounced.

### State distribution

- `GET /api/sessions` gains `activity: 'working'|'waiting'|'idle'` and
  `activity_since: number` per session.
- New WS frame `{type:'activity', sessionId, activity}` broadcast on every transition to
  **all connected sockets** (not just subscribers of that session) so the drawer updates
  for background tabs. Piggybacks on the existing gateway; clients ignore unknown frame
  types today, so this is backward-compatible.
- Mobile/desktop: `SessionDrawer` renders a colored dot per tab — pulsing accent =
  working, attention color + badge = waiting, dim = idle. `useTetherApp` stores the map.

### Persistence

None. Activity state is in-memory, recomputed after server restart from signals 2–3
within seconds. No DB migration for Part 1.

### Desktop client (free win in Slice 1)

The desktop (Tauri) app already has a native OS notification path
(`apps/mobile/src/desktopNotify.ts`) and holds a live WebSocket while open. It simply
maps the new `{type:'activity'}` frame to a native notification on `waiting` (and
optionally `exited`), with the same focus-suppression rule: no notification if that
session is the focused tab of the focused window. No dispatcher, no server work beyond
Part 1 — ships as part of Slice 1.

Limitation: requires the desktop app to be running. When closed, desktop users are
covered by Part 2 channels (ntfy's desktop app and browser Web Push both work on
desktop too).

## Part 2 — Notifications without APNs (the AltStore problem)

Native push is impossible for a sideloaded app (no `aps-environment` entitlement with
free/AltStore signing). Design: a server-side **notification dispatcher** with pluggable
channels. The sideloaded app is never the delivery vehicle; delivery rides on
infrastructure Apple already lets us use.

### Channel A — ntfy (primary, recommended default)

- Server POSTs `{title, body, tags, priority}` to a configurable ntfy endpoint:
  `https://ntfy.sh/<random-topic>` or a self-hosted ntfy over plain HTTP/LAN.
- The user installs the **ntfy app from the App Store** — a properly signed app with
  real APNs push. Tether piggybacks on ntfy's push pipeline.
- Works with zero HTTPS requirement on tether's side, zero Apple account, and also
  covers Android and desktop browsers.
- Topic name is the secret (generated 128-bit random by tether, shown as a
  one-tap subscribe link/QR in the app's settings screen). Message content is kept
  low-sensitivity: session *name* + state only, never terminal output, since ntfy.sh
  is a third party. Self-hosted ntfy lifts that concern.

### Channel B — Web Push PWA (self-hosted purist option)

- iOS 16.4+ grants **real Web Push** to home-screen PWAs — no Apple developer account,
  push arrives via Apple's own infra with the app closed.
- Tether server ships a minimal PWA at `/notify` (one HTML file + service worker +
  manifest, served by the existing Hono app): user opens it in Safari, adds to home
  screen, taps "enable notifications"; the page subscribes and POSTs the subscription
  to `POST /api/push/subscriptions`.
- Server implements Web Push (VAPID + RFC 8291 aes128gcm encryption) using Bun's
  WebCrypto — no native deps. VAPID keypair generated on first use, stored in DB.
- **Constraint:** service workers + Push API require a secure context, so this channel
  needs HTTPS — cleanly satisfied by `tailscale serve` (which the security posture
  already recommends). Documented as a requirement of this channel only.

### Channel C — generic webhook (escape hatch)

- POST JSON to an arbitrary URL (Telegram bot, Pushover, Home Assistant, Discord).
  Trivial once the dispatcher exists; ships because it is ~20 lines.

### Dispatcher rules

- Trigger events: `session → waiting` (default on), `session exited` (default on),
  `session → idle after working ≥ 2 min` ("finished", default off).
- **Debounce:** max 1 notification per session per 60s; a `waiting` notification is
  suppressed if any client currently has that session foregrounded (the app reports
  the active session over its WS — presence signal already implicit in subscription +
  a new `{type:'focus', sessionId}` client frame).
- Config stored in DB (`notification_channels` table via a new migration: id, kind
  `ntfy|webpush|webhook`, config JSON, enabled, created_at). Managed from the app's
  ConfigScreen + `tether notify` CLI subcommand (add/list/remove/test).
- `test` action sends a "hello from tether" through each channel.

### Security notes

- ntfy topic and webhook URLs are capability secrets — stored in DB (0600, same as
  password hash), never logged, redacted in `GET` API responses.
- Web Push subscription endpoints are Apple/Mozilla/Google push URLs; payloads are
  end-to-end encrypted per RFC 8291, so content is safe in transit through Apple.
- Notification payloads never include terminal output by default; opt-in flag
  `include_last_line` per channel for self-hosted endpoints.

## Approaches considered

1. **Native APNs via paid Apple dev account** — rejected: contradicts the AltStore
   constraint, yearly cost, and ties distribution to Apple signing.
2. **Background fetch / BGAppRefresh polling in the sideloaded app** — rejected: iOS
   throttles sideloaded background refresh aggressively; delivery latency minutes-to-
   never. Not push.
3. **Chosen: server-side dispatcher with ntfy + Web Push PWA + webhook.** Reliable
   real push on stock iOS with no Apple account; each channel optional.

## Testing

- `sessionActivity.test.ts` — pure chunk-scanner: bell, OSC 9/777/133 parsing, split-
  across-chunks residuals (mirror `liveCwd.test.ts` cases), silence+prompt heuristics
  via injected clock.
- `notify.test.ts` — dispatcher: debounce, focus suppression, channel fan-out with
  mocked fetch; ntfy/webhook payload shape.
- `webpush.test.ts` — VAPID JWT signing + aes128gcm encryption round-trip against
  known-answer vectors.
- API tests for `activity` field in `/api/sessions` and `activity` WS frame, following
  existing `*.api.test.ts` patterns.

## Rollout

Two independently shippable slices (each its own PR/release):

1. **Slice 1: activity state + badges + desktop native notifications** (no server
   dispatcher, no migration).
2. **Slice 2: dispatcher + ntfy + webhook + config UI/CLI** (one DB migration).
3. **Slice 3: Web Push PWA** (heaviest — crypto + PWA; ships last).

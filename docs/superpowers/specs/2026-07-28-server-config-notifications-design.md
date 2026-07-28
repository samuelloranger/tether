# Server config store & push notifications

Date: 2026-07-28
Status: designed

## Context

Tether today notifies only in the foreground: the attached client parses OSC sequences and raises a local notification. When the app is backgrounded — or attached to a different host entirely — an agent that finishes a turn or asks a question goes unseen.

The goal is "one phone, all my agents, all my machines": several tether hosts, each pushing when a session needs attention, each configurable from the client.

That goal decomposes into three specs. **This document covers Spec 1 only.**

| Spec | Scope | Depends on |
|---|---|---|
| 1 — Server: config store + notifications | this document | — |
| 2 — Client: multi-host | host profiles, grouped drawer, deep links, offline resilience | 1 (for the `Click` URL contract and `identity`) |
| 3 — Server Settings drawer | per-host settings UI over Spec 1's API | 1, 2 |

Spec 1 is independently shippable and has no UI.

## Decisions taken

- **Push transport is ntfy**, URL/topic/token configurable per host. APNs and Expo Push were rejected: the app is sideloaded via AltStore, so a push entitlement means a paid Apple team, and every host would need to reach a cloud relay. ntfy is self-hostable, works from any host, and needs no Apple infra. Cost: alerts land in the ntfy app and deep-link back into tether.
- **Server-side detection, not client-side.** Notifications must fire when no client is attached, so OSC parsing and activity transitions drive them from the PTY output path.
- **Advisory, never blocking.** A dead ntfy endpoint is logged and dropped. Nothing in the notification path can stall or fail a PTY write.

## Existing pieces this builds on

- `settings` table already exists (`db.ts` migration 4). **No new migration.**
- `sessionActivity.ts` already classifies `working | waiting | idle` from the output chokepoint, and `scanChunk` already detects bells and OSC 9 / OSC 777 notifications — today it discards the payload and collapses the signal into `waiting`.
- `sessionTitle.ts` is the model for streaming-safe OSC parsing across chunk boundaries.
- `auth.ts` owns the argon2 password hash and token issuance.
- `pty.ts` owns the subscriber set and the exit frame.

## Section 1 — Config store & API

New `config.ts` over the existing `settings` k/v table. One zod schema (zod is already a dependency), one `getConfig()` returning a fully-defaulted object, one `patchConfig(partial)` that validates and writes only the keys present. Values are stored as JSON strings, one row per top-level key. Unknown keys are rejected rather than ignored.

Schema:

```
notify:    { enabled, url, topic, token? }
triggers:  { waiting, oscNotify, exit, longJob }
longJobSeconds
identity:  { name, color }
session:   { defaultShell, defaultCwd, scrollbackRows, silenceMs }
```

`identity` is consumed by Spec 2's grouped drawer and by the notification title. `silenceMs` and `scrollbackRows` are currently module constants (`SILENCE_MS` in `sessionActivity.ts`, the ~2000-row log cap in `db.ts`); they become config reads.

Routes, behind the normal token auth:

- `GET /api/config` — the full object. `notify.token` is never returned; it is replaced by `notify.hasToken: boolean`.
- `PATCH /api/config` — a validated partial; returns the new full object in the same redacted shape.

An in-process cache holds the parsed config and is invalidated on write, so the per-chunk hot path never hits SQLite.

## Section 2 — Notification engine

`notifier.ts` separates pure logic from I/O:

- `buildNotification(event, ctx): NtfyPayload | null` — pure. Applies the trigger toggles and the enabled flag; returns `null` when suppressed.
- `send(payload, cfg)` — POST to `${url}/${topic}`, bearer token when set, 3s timeout, one retry. Failures are logged, never thrown. Dispatched fire-and-forget off the PTY path.

### Events

| Event | Source |
|---|---|
| `waiting` | the existing `recordOutput` transition to `waiting` |
| `oscNotify` | `scanChunk`, extended from `notify: boolean` to `notify: {title, body} \| null`, parsing `OSC 9;<text>` and `OSC 777;notify;<title>;<body>` |
| `exit` | the PTY exit frame in `pty.ts`, carrying the exit code |
| `longJob` | a `working → idle \| waiting` transition where `now - st.since >= longJobSeconds` |

`longJob` needs no timer: `sessionActivity` already records `since` on every transition.

### Payload mapping

- Title: `<identity.name> · <session title>` (session title from `sessionTitle.autoTitle`).
- Body: per trigger; the OSC body verbatim when the event carries one.
- Tags: one per trigger type.
- Priority: `waiting` is high; the rest are default.
- `Click` header: `tether://session/<sessionId>?host=<identity.name>`.

That `Click` URL is the contract Spec 2's deep-link handler implements: the client matches the `host` param against the `identity.name` it has stored for each profile.

No ordering or delivery guarantee. Notifications are advisory and are dropped silently on failure.

## Section 3 — Focus suppression & WS protocol

New client → server frame: `{type:'focus', focused: boolean}`. The connection already carries its `sessionId`, so the frame only flips a per-connection flag stored alongside the subscriber in `pty.ts` (`Subscriber` gains a focus field). No new store, and the flag dies with the connection — a crashed client cannot wedge a session into permanent silence.

**Suppression rule:** a session is suppressed when at least one attached subscriber has `focused: true`. Subscription alone is not enough; a backgrounded phone keeps its WebSocket alive for a while, and that is exactly when a push is wanted.

A fresh connection defaults to `focused: true`. Reconnects are almost always a user looking at the screen, and being briefly over-quiet beats double-notifying.

Suppression is per session, not per host: being focused on session A still pushes for session B on the same host.

Client contract (implemented in Spec 2, cheap to add now): send `focused: true` on mount and on `AppState → active`; `false` on `AppState → background | inactive` and whenever the drawer covers the terminal.

## Section 4 — Privileged operations

Three routes under `/api/admin`, kept separate from `PATCH /api/config` because they are actions, not settings:

- `POST /api/admin/password` — `{current, next}`. Verifies `current` against the argon2 hash through `auth.ts`, then rotates it. Existing tokens remain valid so the caller is not locked out mid-change.
- `POST /api/admin/update` — `{current}`. Runs the existing `update.ts` path and returns the target version. Responds immediately; the daemon then swaps and restarts, and the client reconnects through the offline handling below.
- `POST /api/admin/restart` — `{current}`. Re-exec. Holders survive by design (`reattachHolders`), so sessions return.

All three require the current password in the body even though the request is already token-authed, are rate-limited to a few attempts per minute, and are written to the daemon log with a timestamp.

Remote log viewing is deliberately excluded. The daemon log is a byte firehose that can contain credentials, and streaming it to a phone over cleartext is not worth the convenience. Use `tether logs` on the box.

### Security assessment

These operations sit behind the same shared password on an unencrypted transport. Anyone holding that password already has a shell on the machine, so remote `update` and `restart` add little new authority — but they are a self-owning primitive if traffic is ever exposed. The password-in-body requirement, the rate limit, and the audit log are the mitigations. The standing guidance is unchanged: run tether behind a tunnel or keep it LAN-only.

## Cross-cutting requirement — offline hosts

Every host is independently failable, and one unreachable host must never degrade the others or the app.

- Per-host state machine: `unknown | reachable | unreachable | unauthorized`.
- Polling a dead host backs off from 2s to a 30s cap rather than hammering it.
- A dead host renders as a greyed, collapsed drawer section with a retry affordance — never an error screen, never a crash.
- A failed poll or connect touches only that host's state.
- Every per-host request is individually caught; no unhandled promise rejections.

Most of this is Spec 2's implementation, but it is recorded here so it is treated as a requirement rather than as polish. The server side already matches the rule: a dead ntfy endpoint is logged and dropped.

## Files

New, each with a sibling `.test.ts` per repo convention:

```
apps/server/src/server/config.ts     schema, defaults, get/patch, cache invalidation
apps/server/src/server/notifier.ts   buildNotification (pure) + send (injectable fetch)
apps/server/src/server/admin.ts      the three privileged operations
```

Modified:

- `sessionActivity.ts` — `notify` payload instead of a boolean; `longJob` transition detection.
- `pty.ts` — focus flag on `Subscriber`; emit the exit event to the notifier; read `session.defaultShell` / `session.defaultCwd` from config in `startSession` (falling back to today's `getDefaultShell()` and `$HOME`).
- `app.ts` — config and admin routes; handle the `focus` frame.
- `db.ts` — read `scrollbackRows` from config. No migration.

## Testing

Nothing here requires a PTY; all new logic is pure or HTTP.

- **config** — defaults on an empty DB; a partial patch leaves sibling keys alone; an unknown key is rejected; the token is redacted on read; the cache is invalidated on write.
- **notifier** — one case per trigger; each toggle off suppresses; OSC body passes through verbatim; priority, tags, and `Click` mapping; `send` swallows a fetch that throws and one that times out.
- **sessionActivity** — OSC 9 and OSC 777 parsing including a sequence split across chunk boundaries; `longJob` fires only past the threshold; no `longJob` for a short working burst.
- **focus** — a focused subscriber suppresses; subscribed-but-unfocused pushes; two clients with one focused suppresses; disconnect clears the flag.
- **admin** — a wrong current password is rejected on all three routes; the rate limit trips; a correct rotation leaves existing tokens working.
- **API** — `GET`/`PATCH /api/config` in the existing `*.api.test.ts` style.

## Out of scope

- Any client UI (Specs 2 and 3).
- Per-session mute, rate limiting/dedup of pushes, and quiet hours. Focus suppression is the only noise control in v1; the others can be added once real-world noise is observed.
- Remote log viewing.
- Hub-and-spoke or proxied hosts. Each host stays independent and directly addressed.

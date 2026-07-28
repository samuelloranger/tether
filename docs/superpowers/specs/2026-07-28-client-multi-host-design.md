# Client: multi-host

Date: 2026-07-28
Status: designed

## Context

Spec 2 of three. See `2026-07-28-server-config-notifications-design.md` for the overall goal ("one phone, all my agents, all my machines") and the split.

Today the client is single-host by construction: one `tether_server_ip` / `tether_port` pair in AsyncStorage, one `tether_password` in SecureStore, and every request built from those. This spec makes the client hold N hosts, show their sessions in one drawer, and survive any of them being offline.

Depends on Spec 1 for `identity` (host name/color) and for the ntfy `Click` URL contract. It does not depend on Spec 3.

## Baseline

`useTetherApp` has been decomposed into `apps/mobile/src/tether/` (`useConnectionConfig`, `useTerminalSessions`, `useTerminalInput`, `usePresentations`, `useDesktopEffects`, `useDesktopUpdater`, `useAppPreferences`, `useTerminalViewport`, `useTerminalUiState`, `types.ts`). This spec builds on that layout.

The two hooks that matter here:

- `useConnectionConfig` — owns the persisted address and password, the pairing/test flow, and the authenticated `request()` helper. It is the single implicit host.
- `useTerminalSessions` — owns `SessionCache`, the per-session `Map<id, TerminalConnectionState>`, reconnect/backoff, and the session list poll. It takes `serverIp`, `port`, and `passwordRef` as three separate scalars and builds URLs inline with `httpBase`/`wsUrl`.

## Decisions taken

- **Global live-socket cap of 3, shared across all hosts.** Every cache-resident session keeps its own socket today; that budget stays as-is and simply spans hosts. Two hosts therefore compete for the same three slots, and a background host's sessions go quiet when the active host fills them. Acceptable because Spec 1's push notifications now cover exactly that gap — a quiet background session still reaches you.
- **Config owns host management; the drawer offers inline add.** First run is unchanged and simply creates host #1.
- **Hosts are independent.** No hub-and-spoke, no proxying. Each is addressed directly and fails alone.

## Section 1 — Host model & storage

New `hostStore.ts`:

```
id            stable uuid, generated once; never the address, which changes
name, color   defaulted from the server's identity config, locally editable
host, port
identityName  last-seen server identity.name — resolves ntfy deep links
order         manual ordering in the drawer
```

The profile list (non-secret) lives in AsyncStorage under one JSON key. Passwords stay in SecureStore, keyed `tether_password_<hostId>`; `secureConfig.ts` gains a `hostId` parameter and loses its single-key API.

Two existing keys become per-host: the active session id (`tether_session_id`) and, new, the active host id (`tether_active_host`).

**Migration**, once, on first launch after upgrade: existing `tether_server_ip` + `tether_port` + the `tether_password` SecureStore entry become host #1 with a generated id and a name defaulted from the server's `identity.name` (falling back to the host string). Legacy keys are deleted only after the new state has been written and read back successfully. With no legacy address present, the store starts empty and the app shows today's pairing flow.

The `useConnectionConfig` default of `'192.168.50.30'` is dropped — a new host form starts empty.

## Section 2 — HostClient & reachability

`hostClient.ts` — one object per profile, holding the base URL, auth header, `get`/`post` helpers, a WS factory, and a `loadIdentity()` that reads `GET /api/config`. Every call in the app goes through a client rather than closing over an implicit host. This is the change that makes everything else possible, and it replaces the `serverIp` / `port` / `passwordRef` triple in `useTerminalSessions`' options with a single `client`.

`hostHealth.ts` — the per-host state machine required by Spec 1's cross-cutting rule:

| State | Entered when | Behavior |
|---|---|---|
| `unknown` | before the first poll | drawer section shows a spinner |
| `reachable` | a poll succeeds | normal; backoff reset |
| `unreachable` | network error / timeout | backoff 2s → 30s cap, keep retrying |
| `unauthorized` | 401 | **stop polling**; require the user to re-enter the password |

A wrong password must not retry forever, hence the terminal `unauthorized` state. Backoff and transition logic are pure functions, tested without React.

`hostPolling.ts` — polls `GET /api/sessions` per host on the existing 4s cadence for the active host, and on a slower cadence (15s) for background hosts, since their badges do not need to be live. Every per-host request is individually caught; a rejection can never escape into another host's path or into a shared effect.

## Section 3 — Sessions across hosts

`useTerminalSessions` becomes host-aware:

- Cache keys become `"<hostId>:<sessionId>"`. Session ids are only unique per host, so the composite key is required — `term-1` exists on every box.
- `SessionCache` keeps `cap = 3` globally. Eviction already disconnects; nothing changes structurally.
- The `Map<id, TerminalConnectionState>` is likewise keyed by the composite id, and each connection holds its own `HostClient`.
- `switchTo(hostId, sessionId)` replaces `switchTo(sessionId)`. Switching hosts is the same code path as switching sessions — hydrate the cached emulator if resident, otherwise connect.
- `connectionStatus` continues to describe the active session only. A background host going unreachable never flashes the active titlebar.
- Killing, renaming, diffs, file tree, uploads, presentations: all already flow through a `request()`-style helper, so they follow the active host's client. No feature is multi-host beyond the session list; a diff view is always about one host.

## Section 4 — Grouped drawer

`SessionDrawer` renders a section per host, ordered by `order`:

- Header row: host name, color dot, live status. `unreachable` renders the section greyed and collapsed with a retry affordance; `unauthorized` renders a "Re-enter password" affordance. Neither is an error screen, and neither blocks the rest of the drawer.
- Session rows are unchanged, including the existing activity dots.
- An "Add host" row sits at the bottom, opening the same pairing flow used at first run.
- The active session is highlighted within its host's section.

`DrawerSession` gains a `hostId`. `onSelect` takes `(hostId, sessionId)`.

Config gains a Hosts screen for the real management UI: reorder, rename, recolor, delete (which also clears that host's SecureStore entry and cache entries), and edit address/password.

## Section 5 — Deep links & focus reporting

**Deep links.** Spec 1 sets the ntfy `Click` header to `tether://session/<sessionId>?host=<identity.name>`. The client registers the `tether` scheme (iOS via `app.json`, desktop via the Tauri deep-link plugin) and resolves the link by matching `host` against each profile's stored `identityName`. On a match: switch to that host and session. On no match: open the app normally and surface a dismissable notice naming the unknown host — never a crash, never a silent no-op.

**Focus reporting.** Spec 1's `{type:'focus', focused}` frame gets sent from `useTerminalSessions`: `true` on mount and on `AppState → active`, `false` on `AppState → background | inactive` and whenever the drawer covers the terminal. Only the active session reports focused; every background session reports unfocused, which is what lets a background session on the *same* host still push.

## Cross-cutting — offline hosts

Restating Spec 1's requirement as this spec's acceptance criteria, since this is where it is implemented:

- One unreachable host never degrades another host or the app.
- No unhandled promise rejections from any per-host request.
- A dead host is visible as dead, retryable, and cheap (backoff, not a hot loop).
- Switching to a dead host shows its state, not a hang.
- Cold start with every host dead still renders a usable app.

## Files

New, each with a sibling test:

```
apps/mobile/src/tether/hostStore.ts      profiles, persistence, migration
apps/mobile/src/tether/hostClient.ts     per-host URLs, auth, fetch, WS factory
apps/mobile/src/tether/hostHealth.ts     state machine + backoff (pure)
apps/mobile/src/tether/hostPolling.ts    per-host session polling
apps/mobile/src/deepLink.ts              tether:// parsing and resolution
apps/mobile/src/HostsScreen.tsx          host management UI
```

Modified: `useConnectionConfig` (per-host, add/edit rather than one global address), `useTerminalSessions` (composite keys, `HostClient`, focus frame), `SessionDrawer` (sections, add-host row), `secureConfig.ts` (`hostId` parameter), `ConfigScreen` (entry point to Hosts).

## Testing

- **hostStore** — migration from legacy keys, including the case where SecureStore has a password but AsyncStorage has no address; legacy keys survive a failed write; profile CRUD; ordering.
- **hostClient** — URL construction for HTTP and WS; auth header present on every call; no secret in any URL.
- **hostHealth** — every transition; backoff growth and 30s cap; `unauthorized` stops polling; success resets backoff.
- **deepLink** — valid link resolves to a profile; unknown host name; malformed URL; a link arriving before the store has loaded.
- **sessions** — composite keys keep same-named sessions on two hosts distinct; global cap 3 evicts across hosts; switching hosts hydrates a resident emulator without reconnecting; `connectionStatus` tracks the active session only.
- **drawer** (component tests) — sections render per host; an unreachable host renders collapsed and greyed; add-host row; selection reports `(hostId, sessionId)`.
- **offline** — a host that always rejects never produces an unhandled rejection and never changes another host's state.

## Out of scope

- Aggregating anything but the session list across hosts. Diffs, files, presentations and uploads stay scoped to the active host.
- Moving or copying sessions between hosts.
- Per-host appearance beyond name and color.
- Server-side settings UI — that is Spec 3.

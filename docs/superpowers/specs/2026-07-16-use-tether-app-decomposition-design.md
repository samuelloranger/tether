# `useTetherApp` decomposition — design

Date: 2026-07-16

## Problem

`apps/mobile/src/useTetherApp.tsx` has grown beyond 1,400 lines. It mixes
connection setup, terminal-session transport, emulator rendering, input
translation, persistence, previews, desktop browser integration, updater
state, and screen-local modal state. The code is difficult to inspect or
change safely because unrelated lifecycles share one hook.

The active multi-tab requirement makes this worse: each cached tab must own a
live connection, but that connection lifecycle must not leak into input,
desktop, or UI concerns.

## Goal

Split the implementation into small, domain-cohesive hooks while retaining
`useTetherApp()` as the sole public facade consumed by `App` and
`TerminalScreen`. The facade preserves its current return shape and behaviour;
the refactor must not require those consumers to orchestrate domains.

Internal hooks own their own state, effects, persistence, and cleanup. They
communicate through narrow, explicit inputs and outputs. There is no global
store, React context, new dependency, or duplicated transport state.

## Internal layout

Create `apps/mobile/src/tether/` for the implementation. Keep
`apps/mobile/src/useTetherApp.tsx` as the composition layer and public export.

- **`types.ts`** — shared domain types only: connection options, terminal grid,
  session-facing actions, and presentation-facing data. It contains no state,
  side effects, or React imports beyond type-only imports.
- **`useConnectionConfig.ts`** — persisted host/port/password, first-run
  pairing mode, connection test, save/edit flow, and a single authenticated
  HTTP helper. It exposes a valid connection descriptor only after setup is
  ready.
- **`useAppPreferences.ts`** — persisted snippets and desktop navigation mode.
  It owns malformed-storage fallback and exposes values plus focused mutation
  methods; it does not own terminal layout or modal visibility.
- **`useTerminalViewport.ts`** — font family/size, window and terminal
  measurements, derived grid dimensions, reduced-motion state, and cursor
  blink. It exposes terminal layout and font actions, with no socket knowledge.
- **`useTerminalSessions.ts`** — the only owner of `SessionCache`, terminal
  emulators, snapshots, active-session identity, and per-session WebSockets.
  Each cache-resident session may have one live connection. It owns reconnect,
  stale-generation guards, resize, LRU eviction cleanup, explicit kill, and
  `send()` for the active session.
- **`useTerminalInput.ts`** — controlled hidden-input diffing, Ctrl handling,
  paste, key sequences, and mouse-report generation. It accepts the active
  terminal metadata and the sessions `send()` action; it never sees a socket
  ref or creates a connection.
- **`usePresentations.ts`** — authenticated preview polling, seen-preview
  tracking, active preview selection, close/reset actions, and the
  session-to-preview navigation rules.
- **`useTerminalUiState.ts`** — screen-local drawer, menu, search, selection,
  rename, appearance, and snippets-editor visibility/draft state. It is only
  view state; persistence remains in the owning domain hook.
- **`useDesktopEffects.ts`** — desktop-only DOM keyboard, wheel,
  context-menu, focus, and drag/drop bindings. It receives the actions and
  state it needs, registers no mobile effects, and cleans up every listener it
  creates.
- **`useDesktopUpdater.ts`** — desktop update check, pending-update details,
  download progress, install action, and failure notification. It is absent on
  mobile and has no terminal/session authority.

Hooks stay separate only while their lifecycle and state ownership are
independent. Do not create one hook per boolean or callback.

## Composition and data flow

`useTetherApp()` creates domains in dependency order:

1. `useConnectionConfig()` and `useAppPreferences()` initialize persisted app
   configuration.
2. `useTerminalViewport()` derives the current terminal grid from dimensions,
   font settings, and navigation preference.
3. `useTerminalSessions({ connection, grid })` opens and manages the active
   session only after configuration is ready. It becomes the sole transport and
   emulator authority.
4. `useTerminalInput({ activeTerminal, send })` turns terminal user events into
   session actions.
5. `usePresentations({ request, activeSessionId })`,
   `useTerminalUiState()`, and `useDesktopUpdater()` manage independent UI
   concerns.
6. `useDesktopEffects({ input, sessions, presentation, ui })` adds desktop-only
   bindings using the already-created domain actions and state.
7. The facade maps these domain outputs back to the existing public object.

The dependency direction is one-way:

```text
config + preferences -> viewport -> sessions -> input + desktop effects
config -------------------------------> presentations
```

`TerminalScreen` and `App` remain consumers of the facade, never dependencies
of internal hooks.

## Session and transport rules

- `useTerminalSessions` holds a `Map<sessionId, ConnectionState>` rather than
  one global socket. A state entry contains only that session's socket,
  generation, open flag, and reconnect timer.
- A cache-resident session opens on first visit. Switching to an already-open
  session repaints its cached emulator snapshot immediately and does not
  reconnect it.
- Incoming output always updates the matching emulator and replay cursor; only
  the active session schedules a React screen update. Only the active session
  may send input or write OSC 52 clipboard data.
- LRU eviction, explicit kill, endpoint/credential changes, and unmount all
  use the sessions hook's disconnect methods. No other hook closes sockets.
- A socket close retries only while its session remains cache-resident. A
  generation guard drops stale messages and closes from replaced connections.
- A connection-status value describes the active session only. Background
  session transitions do not flash the active titlebar.

## Error handling and compatibility

- Failed config reads, request polls, and optional persistence preserve the
  current safe UI state and use the existing notification/dialog path when a
  user-visible error is required.
- Sending with no active open connection remains a harmless no-op.
- Changing address or password disconnects all resident sessions, resets the
  active terminal as today, then reconnects the active session. Background
  sessions reconnect on a later visit.
- Each hook cleans up only timers, subscriptions, listeners, and connections it
  created. No effect reaches into another hook's refs.
- Existing UI behaviour and the `ReturnType<typeof useTetherApp>` contract stay
  compatible throughout the refactor.

## Verification

- Keep existing Bun tests for extracted pure modules and add focused cases when
  an extracted helper introduces logic (especially cache eviction, input,
  mouse, and desktop-key translation). Do not add a new hook-test framework
  solely for this structural refactor.
- Run the full mobile test suite, TypeScript check, formatter/lint, and Tauri
  `cargo build`.
- Manually verify pairing/edit-connection, ordinary terminal input, three live
  tabs with background output, LRU eviction and explicit kill, preview
  navigation, and desktop keyboard/wheel/drop behaviour.

## Out of scope

- Changing the server wire protocol or adding a multiplexed server connection.
- Raising the three-session live-cache cap.
- Redesigning `App` or `TerminalScreen`, changing user-facing behaviour, or
  introducing a global state library.

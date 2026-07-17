# Multi-tab live sync — design

Date: 2026-07-16

## Problem

Tether's mobile/desktop client caches up to 3 terminal sessions as drawer tabs (`SessionCache`, LRU cap 3), but only the *active* tab holds a live WebSocket. Backgrounded tabs are frozen — no socket, no incoming data — until the user switches back to them, at which point the server replays everything missed since `sinceId`. The user wants multiple tabs to stay synced (live) at once, so switching tabs is instant and shows already-current output instead of waiting on a replay.

## Goal

Keep a live WebSocket open for every session resident in the LRU cache (cap stays at 3), not just the active one. Switching tabs becomes a pure UI operation instead of a disconnect/reconnect cycle. No server protocol changes — the server already broadcasts per-session to any number of concurrent subscribers.

## Architecture

Each cached session owns its own WebSocket connection instead of the app owning one global connection torn down on every tab switch. A session's socket opens the first time its tab is visited and stays open as long as it's resident in the cache (cap 3, existing LRU eviction policy unchanged); it closes when the LRU evicts it or the user explicitly kills the session. `switchTo` becomes: flip `activeIdRef`, repaint from the cached emulator's snapshot — opening a socket only as a fallback if the target tab doesn't have one yet (first visit).

## Components

- **`sessionCache.ts`** — `SessionCache` gains an `onEvict?: (id: string, entry: SessionEntry) => void` constructor option, invoked inside `touch()` immediately before the victim is deleted from `map`. Pure addition; existing callers that don't pass it see no behavior change.
- **`useTetherApp.tsx`** — the singleton `sock` / `gen` / `open` / `reconnectTimeout` refs become `connections: Map<string, { sock, gen, open, reconnectTimeout }>`. `connect(id)` / `disconnect(id)` become per-id instead of closing over `activeIdRef` implicitly. `wsSend` looks up the *active* tab's connection entry (only the active tab ever sends input — unchanged, `onReply` keeps its `id === activeIdRef.current` guard). `applyWsMessage(id, data)` needs no change — it's already scoped by `id` for both the write and the render-scheduling skip. Wire the cache's new `onEvict` to call `disconnect(evictedId)`.
  - **Bug fix along the way**: `onClipboardWrite` currently has no active-tab guard (unlike `onReply`), which is harmless today because backgrounded tabs never receive data. Once backgrounded tabs go live, an OSC 52 clipboard-write sequence arriving in a backgrounded tab would silently overwrite the device clipboard unseen. Add the same `if (id === activeIdRef.current)` guard `onReply` already has.
- **`wsTransport.ts`** (Tauri path) — `openTerminalSocket` already mints a per-call `connId`; thread it through so the `ws_send` / `ws_close` `invoke()` calls pass `{ connId, ... }` instead of relying on a single global Rust-side slot.
- **`src-tauri/src/main.rs`** — `Bridge(Mutex<Option<Sender>>)` becomes `Bridge(Mutex<HashMap<String, Sender>>)`. `ws_connect` inserts by `conn_id` instead of closing and replacing the one slot. `ws_send` / `ws_close` take a `conn_id: String` param, look up (and, for close, remove) their entry in the map.

## Data flow & error handling

- **Opening**: `switchTo(id)` / `newTerminal()` call `connect(id)` only if `connections` has no live entry for that id. Each per-id socket wires `onMessage → applyWsMessage(id, data)` (unchanged) and `onClose →` a per-id 3s reconnect, gated on `cache.has(id)` instead of today's `activeIdRef.current === id` — so a backgrounded tab reconnects on its own instead of going stale until revisited.
- **Background writes**: a backgrounded tab's socket keeps calling `applyWsMessage(id, ...)` → `term.write()` plus `sinceId` / `lastAppliedId` advance, but `scheduleRender()` still no-ops for a non-active `id` (unchanged). Net effect: switching to a tab paints the already-current buffer instantly instead of waiting on a replay.
- **Eviction**: LRU push past cap 3 → `onEvict(victimId)` → `disconnect(victimId)` (closes the socket, clears its reconnect timer) at the same point the cache entry is deleted. Revisiting later behaves exactly like a cold reattach does today (fresh `sinceId = 0`, full replay) — no regression, just now scoped to the 4th+ tab instead of every switch.
- **Explicit kill** (`killActiveOr`): calls `disconnect(id)` for that specific id (today's bare `disconnect()` assumed one global connection).
- **`connectionStatus` (titlebar)**: stays a single piece of state, reflecting the *active* tab's connection only. Switching to a tab that already has an open socket sets it to `'connected'` immediately (no transient `'connecting'` flash); switching to a tab with no socket yet behaves as today.
- **Stale-connection guard**: the existing `myGen` / `fresh()` closure pattern carries over unchanged, just one instance per map entry instead of one global pair.

## Testing

- `sessionCache.test.ts`: new cases for `onEvict` — fires on eviction with the correct victim id, does not fire on a plain `get`/`touch` of a still-resident entry.
- No test file exists today for `useTetherApp.tsx` (exercised manually/integration-style, matching existing convention). Manual verification: open 3 tabs, background one actively producing output (e.g. a `watch` loop), switch away and back, confirm output kept arriving (not held back for replay), and confirm an OSC 52 sequence from a backgrounded tab does *not* fire the clipboard write until that tab is active.
- Desktop (Tauri): manual verification — 3 tabs live simultaneously, kill/evict one, confirm its Rust-side connection actually closes (no leaked socket) and the surviving two keep streaming.
- Standard gates before merge: `bun lint`, mobile typecheck, `cargo build` for the Tauri bridge change.

## Out of scope

- Raising the live-tab cap above 3, or removing the cap.
- Server-side socket multiplexing (one WS carrying multiple sessionIds) — considered and rejected as a bigger, riskier change for marginal resource savings at cap 3.
- Extending desktop bell/notification support to backgrounded tabs (currently only tracks the active tab's `bellCount`). Natural follow-on now that backgrounded tabs are live, but not requested — separate task if wanted.

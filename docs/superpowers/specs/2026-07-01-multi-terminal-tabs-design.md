# Multi-terminal (tabs) — Design

**Date:** 2026-07-01
**Status:** Approved (pending implementation plan)
**Scope:** Mobile app (`apps/mobile`) + small server additions (`apps/server`). Web client unchanged.

## Goal

Let the mobile app run and switch between multiple independent shell/agent sessions ("tabs"). Each is a separate persistent PTY on the homelab; background sessions keep running while you use another. Primary use case: several Claude Code agents you switch among from the phone.

## Key decisions (from brainstorming)

- **Model:** switchable terminals (tabs), one visible at a time.
- **Lifecycle:** creating a tab = a new server session (new PTY); closing/leaving a tab = **detach** (session keeps running); explicit **Kill** terminates it.
- **Creation:** `+ New` auto-names `term-N` and starts **bash in `$HOME`** (server already spawns bash in `~`). No per-tab command in v1.
- **Switcher:** a **drawer / session list** (slide-over), not a tab strip.
- **Background sessions sleep:** only the active terminal has a live WebSocket + emulator + rendering. Background agents keep running server-side; drawer status comes from a poll.
- **Client switching = Approach B:** single live WS + a small **LRU cache of emulators** (frozen when not active) for instant switch-back, with incremental catch-up replay. Server **log cap** bounds worst-case replay.

## Single source of truth

The server's session list **is** the tab list. There is no separate client-side tab registry:
- The drawer renders `GET /api/sessions`.
- `+ New` = start a new session id; it then appears in the list.
- Leaving a tab does nothing server-side (session persists).
- `Kill` removes it server-side.

## Server changes (`apps/server`)

1. **`GET /api/sessions`** — include a computed `last_output_at` per session:
   ```sql
   SELECT s.*,
     (SELECT MAX(created_at) FROM terminal_logs WHERE session_id = s.id) AS last_output_at
   FROM sessions ORDER BY created_at DESC
   ```
   No new column, no write amplification. Drives the drawer's active/idle indicator. `status` (`running`/`stopped`) already exists.

2. **Log cap** in `addTerminalLog` (`db.ts`): retain only the last ~2000 rows per session. Prune periodically (roughly every ~200 inserts per session), not on every insert, to avoid write amplification. Example prune:
   ```sql
   DELETE FROM terminal_logs
   WHERE session_id = $id AND id <= (
     SELECT id FROM terminal_logs WHERE session_id = $id
     ORDER BY id DESC LIMIT 1 OFFSET 2000
   )
   ```
   - Bounds reattach replay and finally fixes the unbounded-`terminal_logs` growth flagged in the initial review.
   - **Tradeoff:** bash scrollback older than the cap is lost on reattach. TUIs (Claude Code) are unaffected — the current screen is always a recent full repaint within the cap.

3. `start` / `kill` unchanged. WS `onOpen` already auto-creates a session (`startSession`) if the id is new. No rename endpoint in v1.

## Client architecture (`apps/mobile/App.tsx`)

Replace the single-session model.

- **State:** `activeId` (visible terminal). Persisted to AsyncStorage (`tether_active_id`).
- **Emulator cache (ref):** `Map<id, { term: TerminalEmulator; sinceId: number; lastAppliedId: number }>`, **LRU cap 3**. Track recency (array of ids). Only `activeId` has a live WebSocket. Cached background emulators are frozen (not fed).
- **Existing per-session refs** (`sinceId`, `lastAppliedId`) move into the cache entry so each session tracks its own replay position.

### Switch to session X
1. Close the active WebSocket (keep its emulator in cache).
2. `activeId = X`; move X to front of LRU; evict entries beyond cap 3 (drop their emulators).
3. Ensure a cache entry for X (create a fresh `TerminalEmulator` sized to the device if missing, `sinceId = 0`).
4. `setScreen(X.term.getSnapshot())` — instant paint of last-known screen (empty if new).
5. Open WS for X with `sinceId = X.sinceId`. `onmessage` feeds `X.term`, updates its `sinceId`/`lastAppliedId`, re-renders only while X is still active.
6. Send a resize for the device grid to the newly active session.

Cheap when little happened while away (bounded incremental replay). Full (capped) replay only for uncached / evicted sessions.

### New terminal
`id = term-{max existing N + 1}` → switch to it. WS `onOpen` auto-spawns bash in `~`.

### Kill (from drawer)
`POST /api/sessions/kill {id}` → drop from cache → refresh list. If the killed session was active, switch to the most-recent remaining; if none remain, auto-create `term-1`.

### Unchanged behaviors
Font auto-fit (cols/rows to device), block caret (DECTCEM), swipe→wheel scroll in mouse mode, per-session streaming UTF-8 decode (server), keyboard capture field, render memoization + 30fps throttle.

## UI

- **Header:** `≡` (left) opens the drawer; center shows the active terminal's name + its live connection status. Keep **Reset** (hard kill + restart active) and **Config**.
- **Drawer** (slide-over from left): one row per session from the poll — name, status dot (active row = live connection state; others = running + idle/active derived from `last_output_at`), and a **Kill (✕)** per row. **+ New terminal** at the bottom. Tap a row → switch. Poll `GET /api/sessions` every ~4s while foregrounded; pause when backgrounded.
- **Config:** remove the now-obsolete **Session Name** field. Config = Server IP + Port only.

## Data flow (switch)

```
tap row → close active WS → set activeId + LRU → paint cached snapshot
        → open WS(sinceId) → catch-up feeds cached emulator → live
```

## Edge cases

- Kill active/last session → switch to most-recent remaining; if none, auto-create `term-1`.
- Restored `activeId` was killed server-side → session reports stopped / process exits → existing exit handling offers restart.
- Network drop on the active session → existing per-session reconnect (backoff) applies to `activeId` only.
- Evicted-then-revisited session → fresh emulator + capped replay.
- App backgrounded → pause the drawer poll; active WS handled by existing reconnect on resume.

## Out of scope (v1)

- Push/local notifications when a background agent needs input (requires reliable "waiting for input" detection).
- Rename / reorder tabs; per-tab launch command.
- Web client (`apps/server/src/web`) stays single-session (`default`).

## Testing

- **Emulator:** unchanged; existing `src/terminal.test.ts` still passes.
- **Server log cap:** unit check that `addTerminalLog` beyond the cap prunes oldest rows and `getLogs(sinceId)` returns only retained rows.
- **Manual (device):** create 2–3 terminals, run an agent in each, switch back and forth (verify instant switch-back + catch-up), kill one, kill the active one, cold-restart the app (restores active + list).

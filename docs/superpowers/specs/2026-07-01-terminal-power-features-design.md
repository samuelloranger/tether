# Terminal power features — design

Date: 2026-07-01
Scope: `apps/mobile/App.tsx` (5 features) + `apps/server/src/server/{db.ts,app.ts}` (rename only).

Skipped by user decision: server auth, file upload/download, split panes, push notifications. Not in this spec.

## Overview

Six additions to the mobile terminal, one of which (rename) needs a small server change. The rest are mobile-only UI. A new "⋯" overflow menu in the header hosts the per-session actions so the utility bar and header stay uncluttered.

## 1. ⋯ overflow menu (mobile)

**Problem:** The header's top-right control is a single red restart button (`hardResetSession`, `refresh-cw` icon, `App.tsx:670-679`). New per-session actions (rename, font size, search, snippets) need a home.

**Design:**
- Replace the restart `TouchableOpacity` with one showing a `more-vertical` Feather icon (neutral color `#cbd5e1`, not red).
- New state: `const [menuOpen, setMenuOpen] = useState(false);`
- Tap opens a `Modal` (`animationType="fade"`, transparent) — an action-sheet: a `Pressable` full-screen dim backdrop that closes on tap, containing a panel with vertical rows. RN has no native menu component, so this is a plain Modal + list (same primitive already used for the selection view).
- Rows, each a `TouchableOpacity` with a Feather icon + label:
  - **Rename terminal** (`edit-2`) → opens the rename Modal (§2), closes this menu.
  - **Font size** (`type`) — a row with the label, a `−` button, the current size, and a `+` button inline (§3). Does not close the menu (lets the user tap +/− repeatedly).
  - **Search output** (`search`) → opens the selection view (§4) with search focused, closes this menu.
  - **Snippets** (`terminal`) → opens the snippets Modal (§5), closes this menu.
  - **Restart terminal** (`refresh-cw`, red text) → calls the existing `hardResetSession`, closes this menu. Confirmation is whatever `hardResetSession` already does.

## 2. Rename sessions (server + mobile)

**Problem:** Sessions are identified by `term-1`, `term-2`, … with no human label.

**Server (`db.ts`):**
- Append a migration to the `migrations` array (never edit an applied one):
  ```ts
  {
    version: <next>,
    name: '<next>_session_name',
    up: (db) => db.run('ALTER TABLE sessions ADD COLUMN name TEXT'),
  }
  ```
  (Match the exact shape of existing migration entries — the implementer reads the current array first.)
- Add `renameSession(id, name)`: `UPDATE sessions SET name = $name WHERE id = $id`.
- `listSessions` already returns all columns, so `name` flows through automatically.

**Server (`app.ts`):**
- `POST /api/sessions/rename` — body `{ id, name }`. Trims `name`; empty/whitespace → store `null` (reverts to id display). Calls `renameSession`. Returns `{ ok: true }`.

**Mobile (`App.tsx`):**
- `DrawerSession`/session-list type gains `name?: string | null` (server already sends it).
- Rename Modal: `renameModalOpen` state + `renameText` state. A `Modal` with a `TextInput` (prefilled with current name or id), Save + Cancel. Save → `POST /api/sessions/rename` → `refreshSessions()` → close.
- Display: header title (`App.tsx:626` area, currently `activeId`) and each drawer/tab entry show `name || id`. The rename Modal and menu still operate on the real `id`.

## 3. Font zoom (mobile)

**Problem:** Font size is hardcoded (`const fontSize = 11`, `App.tsx:194`); no way to adjust.

**Design:**
- Change `fontSize` from a const to state: `const [fontSize, setFontSize] = useState(11);`
- On mount, load persisted value from AsyncStorage key `tether.fontSize` (fall back to 11 if absent/invalid).
- `+`/`−` controls in the ⋯ menu (§1) call `setFontSize`, clamped to `[8, 24]`. Persist the new value to AsyncStorage on each change.
- `numCols`/`numRows` (`App.tsx:197-198`) already derive from `fontSize`; the existing resize effect (`App.tsx:420-423`, deps include `numCols`/`numRows`) already resizes the emulator and sends `{type:'resize'}` to the PTY. No new resize wiring needed — changing `fontSize` cascades automatically.

## 4. Search in scrollback (mobile)

**Problem:** No way to find text in a long transcript.

**Design:**
- Extend the existing fullscreen selection Modal (built previously; `selectionViewOpen`, `getFullText()`).
- Add `searchQuery` state and a `TextInput` search box in the Modal header (below the title row).
- The read-only text `TextInput`'s `value` becomes: if `searchQuery` non-empty, `getFullText()` split on `\n`, filtered to lines containing `searchQuery` (case-insensitive), re-joined; else the full transcript (current behavior).
- "Search output" from the ⋯ menu opens this Modal and focuses the search box (via a ref + `autoFocus` on open).
- Clearing the query restores the full transcript. Copy All still copies the full (unfiltered) transcript.

## 5. Command snippets (mobile)

**Problem:** Common commands must be retyped on a mobile keyboard.

**Design:**
- Snippets are a `string[]` persisted in AsyncStorage key `tether.snippets` (default `[]`). Loaded on mount into `snippets` state.
- Snippets Modal (`snippetsModalOpen` state): a list of saved snippets, each row = a `TouchableOpacity` (tap → `sendInput(snippet)`, then close the Modal — no trailing `\r`, so the command lands at the prompt for the user to review/run) + a delete (`x`) button that removes it from state and re-persists.
- An add row at the bottom: a `TextInput` + Add button that appends the trimmed non-empty value and persists.
- **Skipped (YAGNI):** reusing `commandHistory` for a recent-commands list — the history wiring is partly unused (`navigateHistory` is dead). Snippets alone cover the need; revisit if requested.

## 6. More special keys (mobile)

**Problem:** The utility bar lacks navigation keys used by pagers/editors.

**Design:**
- Add four `TouchableOpacity` buttons to the utility bar (`App.tsx:718` region), following the existing button pattern (`sendInput` with a byte string):
  - **Home** → `\x1b[H`
  - **End** → `\x1b[F`
  - **PgUp** → `\x1b[5~`
  - **PgDn** → `\x1b[6~`
- Place them in a new group (after the arrow cluster, before the paste/keyboard icons), separated by the existing `utilityGroupDivider`.
- **Skipped (YAGNI):** F-keys — rarely used on mobile, would crowd the bar. Add later if a real need appears.

## Testing

- **Server (rename):** append an assertion to `apps/server/src/server/db.test.ts` — after `renameSession(id, 'foo')`, `listSessions()` returns that session with `name === 'foo'`; renaming to `''`/whitespace stores `null`. Run: `TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts`.
- **Mobile:** no test runner (UI-only per CLAUDE.md). Manual device verification: `bun dev:mobile`, exercise each feature against a live session.

## Constraints carried from the codebase

- Biome style: 2-space indent, single quotes, semicolons, trailing commas, width 100.
- `bun:sqlite` uses `$name` named params. Migrations are append-only in the `migrations` array in `db.ts`.
- Expo 57 / RN 0.86 / React 19 — read `https://docs.expo.dev/versions/v57.0.0/` before writing Expo code (per `apps/mobile/AGENTS.md`).
- Feather icons from `@expo/vector-icons`.
- AsyncStorage from `@react-native-async-storage/async-storage` (already imported).

# Terminal Power Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session rename, font zoom, scrollback search, command snippets, and navigation keys to the Tether mobile terminal, fronted by a new "⋯" overflow menu in the header.

**Architecture:** One small server change (rename: a migration + one endpoint + one helper). Everything else is mobile UI in `apps/mobile/App.tsx`. A new overflow-menu Modal replaces the lone header restart button and hosts rename / font-size / search / snippets / restart. Font zoom reuses the existing `fontSize → numCols/numRows → resize effect` cascade. Search extends the already-built fullscreen selection Modal.

**Tech Stack:** Bun + Hono + bun:sqlite (server); Expo SDK 57 / RN 0.86 / React 19, `@react-native-async-storage/async-storage`, Feather icons from `@expo/vector-icons` (mobile).

## Global Constraints

- Biome style: 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before each commit.
- `bun:sqlite` uses `$name` named params. Migrations are append-only in the `migrations` array in `db.ts` — never edit an applied one; append a new entry. Migration `up` is a SQL string (see version 1).
- Expo 57 / RN 0.86 / React 19 — read `https://docs.expo.dev/versions/v57.0.0/` before writing Expo code (per `apps/mobile/AGENTS.md`).
- Mobile fetch base URL is `http://${serverIp}:${port}`; WS is `ws://${serverIp}:${port}`.
- No test runner exists for `App.tsx` (UI-only); mobile verification is manual on-device via `bun dev:mobile`. The server has a hand-rolled assert test (`db.test.ts`) run with `TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts`.
- Feature scope excludes auth, file transfer, split panes, notifications (dropped by user).

---

### Task 1: Server — session rename

**Files:**
- Modify: `apps/server/src/server/db.ts` (migrations array, `Session` interface, new `renameSession`)
- Modify: `apps/server/src/server/app.ts` (new `POST /api/sessions/rename` route + import)
- Test: `apps/server/src/server/db.test.ts` (append assertions)

**Interfaces:**
- Produces: `renameSession(id: string, name: string | null): void` exported from `db.ts`. `Session` interface gains `name: string | null`. `POST /api/sessions/rename` accepts `{ id: string, name: string }`, returns `{ ok: true }`. `listSessions()` rows (and thus `GET /api/sessions`) include `name`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/server/db.test.ts`, before the final `console.log` line. Note the import line at the top must also gain `renameSession` — update it to:

```ts
import {
  addTerminalLog,
  getLogs,
  listSessions,
  pruneLogs,
  renameSession,
  upsertSession,
} from './db';
```

Then add this block before the final `console.log`:

```ts
// renameSession sets and clears the name
{
  upsertSession('term-rename', 'bash', 'running');
  renameSession('term-rename', 'my build');
  const named = listSessions().find((r) => r.id === 'term-rename');
  ok(named!.name === 'my build', 'name is set after rename');

  renameSession('term-rename', null);
  const cleared = listSessions().find((r) => r.id === 'term-rename');
  ok(cleared!.name == null, 'name is null after clearing');
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts`
Expected: FAIL — import error / `renameSession is not a function` (or a SQL error about no `name` column) before any of the new assertions pass.

- [ ] **Step 3: Add the migration and column**

In `apps/server/src/server/db.ts`, append a new entry to the `migrations` array (after the version-1 entry). The array currently ends at version 1:

```ts
  {
    version: 2,
    name: 'session_name',
    up: `ALTER TABLE sessions ADD COLUMN name TEXT;`,
  },
```

- [ ] **Step 4: Add `name` to the `Session` interface**

Find:

```ts
export interface Session {
  id: string;
  command: string;
  status: 'running' | 'stopped';
  created_at: string;
}
```

Replace with:

```ts
export interface Session {
  id: string;
  command: string;
  status: 'running' | 'stopped';
  created_at: string;
  name: string | null;
}
```

- [ ] **Step 5: Add the `renameSession` helper**

In `db.ts`, add after `setSessionStatus` (before `deleteSession`):

```ts
export function renameSession(id: string, name: string | null) {
  db.query('UPDATE sessions SET name = $name WHERE id = $id').run({ $id: id, $name: name });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/server && TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts`
Expected: PASS — ends with `N assertions passed` (N is the prior count + 2), no errors.

- [ ] **Step 7: Add the rename endpoint**

In `apps/server/src/server/app.ts`, find the import that pulls DB helpers (top of file — it includes `listSessions`, `killSession`, etc. from their modules). Add `renameSession` to the import from `./db` (locate the existing `from './db'` import and add `renameSession` to its named list).

Then add this route after the `POST /api/sessions/kill` route (which ends at the `});` around line 55):

```ts
app.post('/api/sessions/rename', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = body.id as string | undefined;
  if (!id) return c.json({ ok: false, error: 'missing id' }, 400);
  const trimmed = typeof body.name === 'string' ? body.name.trim() : '';
  renameSession(id, trimmed.length ? trimmed : null);
  return c.json({ ok: true });
});
```

- [ ] **Step 8: Typecheck + format**

Run: `cd apps/server && bun run typecheck` (expected: no errors — note if the pre-existing `bun-types` env issue appears, that is unrelated to this task; report it but it does not block).
Run: `cd /home/samuelloranger/sites/tether && bun format`
Expected: format exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/server/db.ts apps/server/src/server/app.ts apps/server/src/server/db.test.ts
git commit -m "feat(server): session rename (name column, renameSession, POST /api/sessions/rename)"
```

---

### Task 2: Mobile — overflow menu + rename UI

**Files:**
- Modify: `apps/mobile/App.tsx` (header button, new menu Modal, rename Modal, name display, state)
- Modify: `apps/mobile/src/SessionDrawer.tsx` (`DrawerSession` type + label render)

**Interfaces:**
- Consumes: `POST /api/sessions/rename` from Task 1; `name` field on session rows from `GET /api/sessions`.
- Produces: `menuOpen` state + the `⋯` menu Modal (later tasks add rows to it); a helper `activeName` deriving the display label; `renameModalOpen`/`renameText` state.

- [ ] **Step 1: Add `name` to `DrawerSession`**

In `apps/mobile/src/SessionDrawer.tsx`, find:

```tsx
export interface DrawerSession {
  id: string;
  status: 'running' | 'stopped';
  last_output_at: string | null;
}
```

Replace with:

```tsx
export interface DrawerSession {
  id: string;
  status: 'running' | 'stopped';
  last_output_at: string | null;
  name?: string | null;
}
```

- [ ] **Step 2: Show name in the drawer label**

In `apps/mobile/src/SessionDrawer.tsx`, find:

```tsx
                  <Text style={[styles.name, active && styles.nameActive]}>{s.id}</Text>
```

Replace with:

```tsx
                  <Text style={[styles.name, active && styles.nameActive]}>{s.name || s.id}</Text>
```

- [ ] **Step 3: Add menu + rename state in App.tsx**

In `apps/mobile/App.tsx`, find the state block that includes `const [selectionViewOpen, setSelectionViewOpen] = useState(false);` and add after it:

```tsx
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
```

- [ ] **Step 4: Add the `activeName` display helper and `submitRename`**

In `App.tsx`, find the `hardResetSession` function definition (starts `const hardResetSession = () => {`). Add just before it:

```tsx
  const activeName = drawerSessions.find((s) => s.id === activeId)?.name || activeId;

  const openRename = () => {
    setRenameText(drawerSessions.find((s) => s.id === activeId)?.name || '');
    setMenuOpen(false);
    setRenameModalOpen(true);
  };

  const submitRename = async () => {
    const id = activeId;
    const name = renameText.trim();
    setRenameModalOpen(false);
    try {
      await fetch(`http://${serverIp}:${port}/api/sessions/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name }),
      });
      await refreshSessions();
    } catch (err) {
      Alert.alert('Rename failed', String(err));
    }
  };
```

- [ ] **Step 5: Show name in the header title**

In `App.tsx`, find:

```tsx
              <Text style={styles.headerTitle}>{activeId}</Text>
```

Replace with:

```tsx
              <Text style={styles.headerTitle}>{activeName}</Text>
```

- [ ] **Step 6: Replace the restart button with the ⋯ menu button**

In `App.tsx`, find the header restart `TouchableOpacity`:

```tsx
              <TouchableOpacity
                style={styles.headerBtn}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                onPress={hardResetSession}
                accessibilityRole="button"
                accessibilityLabel="Restart this terminal"
              >
                <Feather name="refresh-cw" size={17} color="#f87171" />
              </TouchableOpacity>
```

Replace with:

```tsx
              <TouchableOpacity
                style={styles.headerBtn}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                onPress={() => setMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Terminal menu"
              >
                <Feather name="more-vertical" size={19} color="#cbd5e1" />
              </TouchableOpacity>
```

- [ ] **Step 7: Add the overflow menu Modal and rename Modal**

In `App.tsx`, find the selection-view Modal block (it starts with `<Modal` and `visible={selectionViewOpen}`). Add immediately BEFORE that `<Modal` opening tag:

```tsx
          {/* Overflow menu (header ⋯) */}
          <Modal
            visible={menuOpen}
            animationType="fade"
            transparent
            onRequestClose={() => setMenuOpen(false)}
          >
            <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
              <Pressable style={styles.menuPanel} onPress={() => {}}>
                <TouchableOpacity style={styles.menuRow} onPress={openRename}>
                  <Feather name="edit-2" size={16} color="#cbd5e1" />
                  <Text style={styles.menuRowText}>Rename terminal</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuRow}
                  onPress={() => {
                    setMenuOpen(false);
                    hardResetSession();
                  }}
                >
                  <Feather name="refresh-cw" size={16} color="#f87171" />
                  <Text style={[styles.menuRowText, { color: '#f87171' }]}>Restart terminal</Text>
                </TouchableOpacity>
              </Pressable>
            </Pressable>
          </Modal>

          {/* Rename Modal */}
          <Modal
            visible={renameModalOpen}
            animationType="fade"
            transparent
            onRequestClose={() => setRenameModalOpen(false)}
          >
            <Pressable style={styles.menuBackdrop} onPress={() => setRenameModalOpen(false)}>
              <Pressable style={styles.renamePanel} onPress={() => {}}>
                <Text style={styles.renameTitle}>Rename terminal</Text>
                <TextInput
                  style={styles.renameInput}
                  value={renameText}
                  onChangeText={setRenameText}
                  placeholder={activeId}
                  placeholderTextColor="#64748b"
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={submitRename}
                  keyboardAppearance="dark"
                />
                <View style={styles.renameBtns}>
                  <TouchableOpacity
                    style={styles.renameBtn}
                    onPress={() => setRenameModalOpen(false)}
                  >
                    <Text style={styles.renameBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.renameBtn} onPress={submitRename}>
                    <Text style={[styles.renameBtnText, { color: '#22d3ee' }]}>Save</Text>
                  </TouchableOpacity>
                </View>
              </Pressable>
            </Pressable>
          </Modal>
```

- [ ] **Step 8: Add styles**

In `App.tsx`, find the `selectionViewContainer` style entry in the `StyleSheet.create` block and add these entries immediately before it:

```tsx
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  menuPanel: {
    alignSelf: 'flex-end',
    marginTop: 60,
    marginRight: 12,
    minWidth: 200,
    backgroundColor: '#0b0f19',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    paddingVertical: 6,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  menuRowText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#cbd5e1',
  },
  renamePanel: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#0b0f19',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 20,
    gap: 14,
  },
  renameTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  renameInput: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e2e8f0',
    fontSize: 15,
  },
  renameBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
  },
  renameBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  renameBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#94a3b8',
  },
```

- [ ] **Step 9: Format**

Run: `cd /home/samuelloranger/sites/tether && bun format`
Expected: exits 0. (Note: two pre-existing diagnostics — `navigateHistory` unused, `blurOnSubmit` deprecated — are out of scope; do not fix them.)

- [ ] **Step 10: Manual verification**

Run `bun dev:mobile`, connect to a session. Verify: tapping ⋯ opens the menu; "Rename terminal" opens the rename box prefilled; saving a name updates the header title and drawer entry; saving an empty name reverts to the id; "Restart terminal" performs the old restart; tapping the backdrop closes menus.

- [ ] **Step 11: Commit**

```bash
git add apps/mobile/App.tsx apps/mobile/src/SessionDrawer.tsx
git commit -m "feat(mobile): header overflow menu + session rename UI"
```

---

### Task 3: Mobile — font zoom

**Files:**
- Modify: `apps/mobile/App.tsx` (fontSize state + persistence + menu +/− row)

**Interfaces:**
- Consumes: the `menuPanel` menu from Task 2 (adds a row to it); the existing `numCols`/`numRows` derivation and resize effect.
- Produces: `fontSize` state (replaces the const) + `KEY_FONT` storage key.

- [ ] **Step 1: Add the storage key**

In `apps/mobile/App.tsx`, find the storage-key consts:

```tsx
const KEY_SERVER_IP = 'tether_server_ip';
const KEY_PORT = 'tether_port';
const KEY_SESSION_ID = 'tether_session_id';
const KEY_HISTORY = 'tether_history';
```

Add after them:

```tsx
const KEY_FONT = 'tether_font_size';
```

- [ ] **Step 2: Convert `fontSize` from const to state**

Find:

```tsx
  const CHAR_RATIO = 0.6;
  const fontSize = 11;
  const lineHeight = Math.round(fontSize * 1.3);
```

Replace with:

```tsx
  const CHAR_RATIO = 0.6;
  const [fontSize, setFontSize] = useState(11);
  const lineHeight = Math.round(fontSize * 1.3);
```

- [ ] **Step 3: Load persisted font size on mount and add the setter**

In `App.tsx`, add a new `useEffect` immediately after the `const lineHeight = ...` line's containing block is closed is not reliable; instead add it right after the `activeIdRef` sync effect (the one with body `activeIdRef.current = activeId;`). Add:

```tsx
  // Load persisted font size once on mount.
  useEffect(() => {
    AsyncStorage.getItem(KEY_FONT).then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 8 && n <= 24) setFontSize(n);
    });
  }, []);

  const changeFontSize = (delta: number) => {
    setFontSize((prev) => {
      const next = Math.min(24, Math.max(8, prev + delta));
      AsyncStorage.setItem(KEY_FONT, String(next));
      return next;
    });
  };
```

- [ ] **Step 4: Add the font-size row to the overflow menu**

In `App.tsx`, find the menu "Rename terminal" row inside the `menuPanel` (from Task 2):

```tsx
                <TouchableOpacity style={styles.menuRow} onPress={openRename}>
                  <Feather name="edit-2" size={16} color="#cbd5e1" />
                  <Text style={styles.menuRowText}>Rename terminal</Text>
                </TouchableOpacity>
```

Add immediately after it (this row does NOT close the menu, so +/− can be tapped repeatedly):

```tsx
                <View style={styles.menuRow}>
                  <Feather name="type" size={16} color="#cbd5e1" />
                  <Text style={[styles.menuRowText, { flex: 1 }]}>Font size</Text>
                  <TouchableOpacity
                    style={styles.fontStepBtn}
                    onPress={() => changeFontSize(-1)}
                    accessibilityLabel="Decrease font size"
                  >
                    <Text style={styles.fontStepText}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.fontSizeValue}>{fontSize}</Text>
                  <TouchableOpacity
                    style={styles.fontStepBtn}
                    onPress={() => changeFontSize(1)}
                    accessibilityLabel="Increase font size"
                  >
                    <Text style={styles.fontStepText}>+</Text>
                  </TouchableOpacity>
                </View>
```

- [ ] **Step 5: Add font-control styles**

In `App.tsx`, add these entries immediately before the `menuBackdrop` style entry (added in Task 2):

```tsx
  fontStepBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fontStepText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  fontSizeValue: {
    minWidth: 24,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: '#e2e8f0',
  },
```

- [ ] **Step 6: Format**

Run: `cd /home/samuelloranger/sites/tether && bun format`
Expected: exits 0.

- [ ] **Step 7: Manual verification**

Run `bun dev:mobile`. Open ⋯ → Font size. Tap `+`/`−`: the terminal text grows/shrinks, the grid reflows (cols/rows change, PTY resizes — confirm by running `tput cols` / `stty size` in the shell before and after). Clamp holds at 8 and 24. Kill and reopen the app: the last font size persists.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): adjustable font size in the overflow menu (persisted)"
```

---

### Task 4: Mobile — search in scrollback

**Files:**
- Modify: `apps/mobile/App.tsx` (selection Modal gains a search box; menu gains a "Search output" row)

**Interfaces:**
- Consumes: the existing `selectionViewOpen` state, `getFullText()` helper, and the selection Modal; the `menuPanel` menu from Task 2.
- Produces: `searchQuery` state + a `searchInputRef`.

- [ ] **Step 1: Add search state and a ref**

In `App.tsx`, find the state additions from Task 2 (`const [menuOpen, setMenuOpen] = useState(false);` etc.) and add after them:

```tsx
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInput | null>(null);
```

- [ ] **Step 2: Add a filtered-text helper and the menu opener**

In `App.tsx`, find the `getFullText` helper (`const getFullText = () =>` ... ending in `.replace(/\n+$/, '');`). Add immediately after it:

```tsx
  // Transcript filtered to lines matching the search query (case-insensitive);
  // full transcript when the query is empty.
  const getSearchText = () => {
    const full = getFullText();
    const q = searchQuery.trim().toLowerCase();
    if (!q) return full;
    return full
      .split('\n')
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n');
  };

  const openSearch = () => {
    setMenuOpen(false);
    setSearchQuery('');
    setSelectionViewOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 250);
  };
```

- [ ] **Step 3: Add the "Search output" menu row**

In `App.tsx`, find the font-size row's closing `</View>` inside `menuPanel` (added in Task 3) and add after it:

```tsx
                <TouchableOpacity style={styles.menuRow} onPress={openSearch}>
                  <Feather name="search" size={16} color="#cbd5e1" />
                  <Text style={styles.menuRowText}>Search output</Text>
                </TouchableOpacity>
```

- [ ] **Step 4: Add the search box to the selection Modal and switch its value to the filtered text**

In `App.tsx`, find the selection Modal header row:

```tsx
              <View style={styles.selectionViewHeader}>
                <Text style={styles.selectionViewTitle}>Select Text</Text>
```

Replace the `selectionViewHeader` `<View>` opening and title so a search box sits under the title row. Concretely, find the whole header block that ends with its closing `</View>` before the `{selectionViewOpen && (` guard, and insert the search `TextInput` right after that closing `</View>`:

```tsx
              <TextInput
                ref={searchInputRef}
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Filter lines…"
                placeholderTextColor="#64748b"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardAppearance="dark"
              />
```

Then find the read-only selection `TextInput` inside the `{selectionViewOpen && (` guard:

```tsx
                <TextInput
                  style={styles.selectionViewText}
                  value={getFullText()}
                  editable={false}
                  multiline
                  scrollEnabled
                  selection={{ start: getFullText().length, end: getFullText().length }}
                />
```

Replace with (value/selection now use the filtered text; guard so an empty filtered result doesn't crash the `selection` math):

```tsx
                <TextInput
                  style={styles.selectionViewText}
                  value={getSearchText()}
                  editable={false}
                  multiline
                  scrollEnabled
                  selection={{ start: getSearchText().length, end: getSearchText().length }}
                />
```

- [ ] **Step 5: Reset the search query when the view closes**

In `App.tsx`, find the selection Modal's close button `onPress` (`onPress={() => setSelectionViewOpen(false)}`) and the `onRequestClose` on that Modal. Change BOTH to also clear the query. For each occurrence of `setSelectionViewOpen(false)` inside the selection Modal (the `onRequestClose` and the X button), replace with:

```tsx
() => {
                setSelectionViewOpen(false);
                setSearchQuery('');
              }
```

(Match indentation to the surrounding JSX. There are two such handlers in the selection Modal; update both. Do NOT change `openSelectionView` or the long-press wiring.)

- [ ] **Step 6: Add the search-input style**

In `App.tsx`, find the `selectionViewText` style entry and add before it:

```tsx
  searchInput: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#e2e8f0',
    fontSize: 14,
  },
```

- [ ] **Step 7: Format**

Run: `cd /home/samuelloranger/sites/tether && bun format`
Expected: exits 0.

- [ ] **Step 8: Manual verification**

Run `bun dev:mobile`. Produce varied output (e.g. `seq 1 200; echo apple; echo banana`). Open ⋯ → Search output: the selection view opens with the search box focused. Type `apple`: only matching lines remain, still selectable/copyable. Clear the query: full transcript returns. Long-press the terminal directly: opens the same view with an empty query (full transcript). Copy All still copies the full unfiltered transcript.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): filter/search scrollback in the fullscreen text view"
```

---

### Task 5: Mobile — command snippets

**Files:**
- Modify: `apps/mobile/App.tsx` (snippets state + persistence + Modal + menu row)

**Interfaces:**
- Consumes: the `menuPanel` menu from Task 2; the existing `sendInput(text: string)` function.
- Produces: `snippets` state + `KEY_SNIPPETS` storage key + `snippetsModalOpen` state.

- [ ] **Step 1: Add the storage key**

In `App.tsx`, find the `KEY_FONT` const (added in Task 3) and add after it:

```tsx
const KEY_SNIPPETS = 'tether_snippets';
```

- [ ] **Step 2: Add snippets state**

In `App.tsx`, find the search state (`const [searchQuery, setSearchQuery] = useState('');` from Task 4) and add after it:

```tsx
  const [snippets, setSnippets] = useState<string[]>([]);
  const [snippetsModalOpen, setSnippetsModalOpen] = useState(false);
  const [snippetDraft, setSnippetDraft] = useState('');
```

- [ ] **Step 3: Load snippets on mount and add persist/add/remove/send helpers**

In `App.tsx`, find the font-size load effect (added in Task 3, the `useEffect` reading `KEY_FONT`) and add after it:

```tsx
  // Load persisted snippets once on mount.
  useEffect(() => {
    AsyncStorage.getItem(KEY_SNIPPETS).then((v) => {
      if (!v) return;
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) setSnippets(parsed.filter((s) => typeof s === 'string'));
      } catch {
        // ignore malformed storage
      }
    });
  }, []);

  const persistSnippets = (next: string[]) => {
    setSnippets(next);
    AsyncStorage.setItem(KEY_SNIPPETS, JSON.stringify(next));
  };

  const addSnippet = () => {
    const s = snippetDraft.trim();
    if (!s) return;
    persistSnippets([...snippets, s]);
    setSnippetDraft('');
  };

  const removeSnippet = (index: number) => {
    persistSnippets(snippets.filter((_, i) => i !== index));
  };

  const sendSnippet = (s: string) => {
    setSnippetsModalOpen(false);
    sendInput(s);
  };
```

- [ ] **Step 4: Add the "Snippets" menu row**

In `App.tsx`, find the "Search output" menu row (added in Task 4) and add after it:

```tsx
                <TouchableOpacity
                  style={styles.menuRow}
                  onPress={() => {
                    setMenuOpen(false);
                    setSnippetsModalOpen(true);
                  }}
                >
                  <Feather name="terminal" size={16} color="#cbd5e1" />
                  <Text style={styles.menuRowText}>Snippets</Text>
                </TouchableOpacity>
```

- [ ] **Step 5: Add the Snippets Modal**

In `App.tsx`, find the rename Modal block (from Task 2, ends with its closing `</Modal>`). Add immediately after it:

```tsx
          {/* Snippets Modal */}
          <Modal
            visible={snippetsModalOpen}
            animationType="fade"
            transparent
            onRequestClose={() => setSnippetsModalOpen(false)}
          >
            <Pressable style={styles.menuBackdrop} onPress={() => setSnippetsModalOpen(false)}>
              <Pressable style={styles.renamePanel} onPress={() => {}}>
                <Text style={styles.renameTitle}>Snippets</Text>
                {snippets.length === 0 && (
                  <Text style={styles.snippetEmpty}>No snippets yet. Add one below.</Text>
                )}
                {snippets.map((s, i) => (
                  <View key={`${s}-${i}`} style={styles.snippetRow}>
                    <TouchableOpacity style={styles.snippetSend} onPress={() => sendSnippet(s)}>
                      <Text style={styles.snippetText} numberOfLines={1}>
                        {s}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.snippetDelete}
                      onPress={() => removeSnippet(i)}
                      accessibilityLabel={`Delete snippet ${s}`}
                    >
                      <Feather name="x" size={16} color="#94a3b8" />
                    </TouchableOpacity>
                  </View>
                ))}
                <View style={styles.snippetAddRow}>
                  <TextInput
                    style={[styles.renameInput, { flex: 1 }]}
                    value={snippetDraft}
                    onChangeText={setSnippetDraft}
                    placeholder="New snippet (e.g. git status)"
                    placeholderTextColor="#64748b"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onSubmitEditing={addSnippet}
                    keyboardAppearance="dark"
                  />
                  <TouchableOpacity style={styles.snippetAddBtn} onPress={addSnippet}>
                    <Feather name="plus" size={18} color="#22d3ee" />
                  </TouchableOpacity>
                </View>
              </Pressable>
            </Pressable>
          </Modal>
```

- [ ] **Step 6: Add snippet styles**

In `App.tsx`, add these entries immediately before the `menuBackdrop` style entry:

```tsx
  snippetEmpty: {
    color: '#64748b',
    fontSize: 13,
  },
  snippetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  snippetSend: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  snippetText: {
    color: '#e2e8f0',
    fontSize: 14,
    fontFamily: MONO,
  },
  snippetDelete: {
    padding: 8,
  },
  snippetAddRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  snippetAddBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
```

- [ ] **Step 7: Format**

Run: `cd /home/samuelloranger/sites/tether && bun format`
Expected: exits 0.

- [ ] **Step 8: Manual verification**

Run `bun dev:mobile`. Open ⋯ → Snippets. Add `git status`; it appears in the list. Tap it: the Modal closes and `git status` appears at the prompt (NOT auto-run — no trailing newline), ready to edit/run. Delete it with the `x`. Kill and reopen the app: saved snippets persist.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): command snippets (persisted, send-to-prompt) in the overflow menu"
```

---

### Task 6: Mobile — navigation keys in the utility bar

**Files:**
- Modify: `apps/mobile/App.tsx` (utility bar gains Home/End/PgUp/PgDn buttons)

**Interfaces:**
- Consumes: the existing `sendInput(text: string)` and the utility-bar JSX + `utilityBtn`/`utilityGroupDivider` styles.
- Produces: nothing consumed downstream (last task).

- [ ] **Step 1: Add the navigation-key button group**

In `App.tsx`, find the arrow cluster in the utility bar and the divider that follows it:

```tsx
              <ArrowCluster
                onArrow={(dir) => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  sendInput(`\x1b[${dir}`);
                }}
              />

              <View style={styles.utilityGroupDivider} />
```

Add immediately AFTER that `<View style={styles.utilityGroupDivider} />`:

```tsx
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[H')}>
                <Text style={styles.utilityBtnText}>Home</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[F')}>
                <Text style={styles.utilityBtnText}>End</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[5~')}>
                <Text style={styles.utilityBtnText}>PgUp</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[6~')}>
                <Text style={styles.utilityBtnText}>PgDn</Text>
              </TouchableOpacity>

              <View style={styles.utilityGroupDivider} />
```

- [ ] **Step 2: Format**

Run: `cd /home/samuelloranger/sites/tether && bun format`
Expected: exits 0.

- [ ] **Step 3: Manual verification**

Run `bun dev:mobile`. In a pager (e.g. `less /etc/services` or `man ls`), verify PgUp/PgDn page the view and Home/End jump to top/bottom. In an editor or shell, confirm Home/End move the cursor to line start/end where the program supports it. (Behavior is program-dependent; the goal is that the correct escape bytes are sent — cross-check with `cat -v` showing `^[[H`, `^[[F`, `^[[5~`, `^[[6~`.)

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): Home/End/PgUp/PgDn navigation keys in the utility bar"
```

---

## Self-Review Notes

- **Spec coverage:** §1 overflow menu → Task 2 (+ rows added in Tasks 3/4/5). §2 rename → Tasks 1 (server) + 2 (mobile). §3 font zoom → Task 3. §4 search → Task 4. §5 snippets → Task 5. §6 nav keys → Task 6. All spec sections mapped.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code. Migration version is concrete (2). The one prose-guided edit (Task 4 Step 5, updating both close handlers) names exactly what to change and what not to touch.
- **Type consistency:** `renameSession(id, name|null)` signature identical across Task 1 db.ts, its test, and Task 2's fetch body shape. `name: string | null` on `Session` (server) and `name?: string | null` on `DrawerSession` (client). `getFullText`/`getSearchText`/`sendInput`/`sendSnippet` names consistent across tasks. `KEY_FONT`/`KEY_SNIPPETS` defined once. Menu rows are appended in a defined order (Rename → Font → Search → Snippets → Restart-is-last-in-Task-2's-panel); Task 3/4/5 each anchor to the previously-added row, so ordering is deterministic.
- **Ordering note:** Task 2's menu panel initially has Rename + Restart. Tasks 3–5 insert Font/Search/Snippets AFTER Rename (and thus before Restart), so the final visual order is Rename, Font size, Search output, Snippets, Restart. This is intentional and consistent with anchors.

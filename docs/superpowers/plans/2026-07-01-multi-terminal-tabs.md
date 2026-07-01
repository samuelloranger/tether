# Multi-terminal (tabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the mobile app run and switch between multiple persistent shell/agent sessions ("tabs"), one visible at a time, backed by the existing per-session PTY model.

**Architecture:** The server's session list is the tab list. The mobile app keeps one live WebSocket + an LRU cache of up to 3 emulators (background ones frozen) for instant switch-back with incremental catch-up replay. A server-side log cap bounds replay. A slide-over drawer lists sessions from a poll.

**Tech Stack:** Bun + Hono + bun:sqlite (server); Expo React Native + TypeScript (mobile). Tests run with `bun test` / `bun run <file>` for pure modules. RN UI is verified manually on device (no RN test framework in this repo).

## Global Constraints

- Server PTY requires **Bun ≥ 1.3.14** (`proc.terminal`). Current: 1.3.14.
- Formatting: Biome — 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun --cwd apps/server format` for server files.
- Emulator/session pure logic is TDD'd with `bun run <file>.test.ts` (assert-based, no framework), matching existing `apps/mobile/src/terminal.test.ts`.
- Session id format is `term-<N>` (N ≥ 1); the display name is the id.
- LRU emulator cache cap = 3. Server log cap = 2000 rows/session, pruned every 200 inserts.
- Web client (`apps/server/src/web`) is out of scope — do not modify.

---

## File Structure

- **Create** `apps/mobile/src/sessionCache.ts` — pure LRU emulator cache + `nextTermId`. Testable.
- **Create** `apps/mobile/src/sessionCache.test.ts` — assert-based tests.
- **Create** `apps/mobile/src/SessionDrawer.tsx` — presentational slide-over list.
- **Modify** `apps/server/src/server/db.ts` — `listSessions()` (with `last_output_at`), `pruneLogs()`, log cap in `addTerminalLog`.
- **Create** `apps/server/src/server/db.test.ts` — assert-based tests for prune + listSessions.
- **Modify** `apps/server/src/server/app.ts` — `/api/sessions` uses `listSessions()`.
- **Modify** `apps/mobile/App.tsx` — multi-session state, switching, poll, header drawer button, Config cleanup, persistence.

---

## Task 1: Server — `listSessions()` with activity timestamp

**Files:**
- Modify: `apps/server/src/server/db.ts`
- Modify: `apps/server/src/server/app.ts`
- Test: `apps/server/src/server/db.test.ts`

**Interfaces:**
- Produces: `interface SessionRow extends Session { last_output_at: string | null }` and `listSessions(): SessionRow[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/server/db.test.ts`:

```ts
// Run: TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts
import { upsertSession, addTerminalLog, listSessions, pruneLogs, getLogs } from './db';

let pass = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL ${msg}`);
  pass++;
}

// listSessions returns rows with last_output_at
{
  upsertSession('term-1', 'bash', 'running');
  addTerminalLog('term-1', 'hello');
  const rows = listSessions();
  const row = rows.find((r) => r.id === 'term-1');
  ok(!!row, 'listSessions includes term-1');
  ok(row!.last_output_at != null, 'term-1 has last_output_at after output');

  upsertSession('term-2', 'bash', 'running');
  const empty = listSessions().find((r) => r.id === 'term-2');
  ok(empty!.last_output_at == null, 'term-2 has null last_output_at with no output');
}

console.log(`\n  ${pass} assertions passed\n`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && TETHER_DB_PATH="/tmp/tether-test-$$.db" bun run src/server/db.test.ts`
Expected: FAIL — `listSessions` / `pruneLogs` not exported (import error).

- [ ] **Step 3: Add `listSessions` to `db.ts`**

In `apps/server/src/server/db.ts`, after the existing `getLogs`/`clearLogs`/`setSessionStatus` helpers, add:

```ts
export interface SessionRow extends Session {
  last_output_at: string | null;
}

export function listSessions(): SessionRow[] {
  return db
    .query(
      `SELECT s.*,
        (SELECT MAX(created_at) FROM terminal_logs WHERE session_id = s.id) AS last_output_at
       FROM sessions ORDER BY created_at DESC`,
    )
    .all() as SessionRow[];
}
```

(`pruneLogs` is added in Task 2; this task's test only exercises `listSessions`. If running the whole test file now, comment out the `pruneLogs` import until Task 2 — but prefer running tasks in order.)

- [ ] **Step 4: Run test to verify `listSessions` assertions pass**

Run: `cd apps/server && TETHER_DB_PATH="/tmp/tether-test-$$.db" bun run src/server/db.test.ts`
Expected: PASS (3 assertions) — or an import error on `pruneLogs` only; if so, temporarily comment the `pruneLogs` import, re-run, then restore in Task 2.

- [ ] **Step 5: Use `listSessions()` in the route**

In `apps/server/src/server/app.ts`, update the import from `./db` to include `listSessions`, and replace the `/api/sessions` handler body:

```ts
app.get('/api/sessions', (c) => {
  return c.json(listSessions());
});
```

Remove the now-unused inline `db.query('SELECT * FROM sessions ...')`. Keep the `db` import only if still used elsewhere in `app.ts` (it is — `/api/sessions` previously used it; after this change, check remaining `db.` usages and drop the import if none).

- [ ] **Step 6: Commit**

```bash
cd /Users/samuelloranger/Sites/projets_perso/tether
git add apps/server/src/server/db.ts apps/server/src/server/app.ts apps/server/src/server/db.test.ts
git commit -m "feat(server): listSessions with last_output_at for tab drawer"
```

---

## Task 2: Server — log cap (prune per session)

**Files:**
- Modify: `apps/server/src/server/db.ts`
- Test: `apps/server/src/server/db.test.ts`

**Interfaces:**
- Produces: `pruneLogs(sessionId: string, cap?: number): void`. `addTerminalLog` unchanged signature, now prunes internally every 200 inserts.

- [ ] **Step 1: Add the failing test**

Append to `apps/server/src/server/db.test.ts` (before the final `console.log`):

```ts
// pruneLogs keeps only the last `cap` rows for a session
{
  upsertSession('term-cap', 'bash', 'running');
  for (let i = 0; i < 50; i++) addTerminalLog('term-cap', `line ${i}`);
  pruneLogs('term-cap', 10);
  const logs = getLogs('term-cap', 0);
  ok(logs.length === 10, `prune keeps 10 rows, got ${logs.length}`);
  ok(logs[logs.length - 1].chunk === 'line 49', 'newest row retained');
  ok(logs[0].chunk === 'line 40', 'oldest retained is line 40');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && TETHER_DB_PATH="/tmp/tether-test-$$.db" bun run src/server/db.test.ts`
Expected: FAIL — `pruneLogs` is not exported.

- [ ] **Step 3: Implement `pruneLogs` + wire into `addTerminalLog`**

In `apps/server/src/server/db.ts`, add near the top of the helpers section:

```ts
const LOG_CAP = 2000;
const insertCounts = new Map<string, number>();

export function pruneLogs(sessionId: string, cap = LOG_CAP) {
  db.query(
    `DELETE FROM terminal_logs
     WHERE session_id = $id AND id <= (
       SELECT id FROM terminal_logs WHERE session_id = $id
       ORDER BY id DESC LIMIT 1 OFFSET $cap
     )`,
  ).run({ $id: sessionId, $cap: cap });
}
```

Then modify the existing `addTerminalLog` to prune every 200 inserts:

```ts
export function addTerminalLog(sessionId: string, chunk: string): number {
  const result = db
    .query(`INSERT INTO terminal_logs (session_id, chunk) VALUES ($sessionId, $chunk)`)
    .run({ $sessionId: sessionId, $chunk: chunk });
  const n = (insertCounts.get(sessionId) ?? 0) + 1;
  insertCounts.set(sessionId, n);
  if (n % 200 === 0) pruneLogs(sessionId);
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && TETHER_DB_PATH="/tmp/tether-test-$$.db" bun run src/server/db.test.ts`
Expected: PASS (all assertions, including the 3 prune assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/db.ts apps/server/src/server/db.test.ts
git commit -m "feat(server): cap terminal_logs per session (prune every 200 inserts)"
```

---

## Task 3: Client — `sessionCache` pure module

**Files:**
- Create: `apps/mobile/src/sessionCache.ts`
- Test: `apps/mobile/src/sessionCache.test.ts`

**Interfaces:**
- Consumes: `TerminalEmulator` from `./terminal`.
- Produces:
  - `interface SessionEntry { term: TerminalEmulator; sinceId: number; lastAppliedId: number }`
  - `class SessionCache` with `get(id)`, `has(id)`, `touch(id, make)`, `delete(id)`, `ids()`.
  - `nextTermId(existing: string[]): string`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/sessionCache.test.ts`:

```ts
// Run: bun run src/sessionCache.test.ts   (from apps/mobile)
import { SessionCache, nextTermId, type SessionEntry } from './sessionCache';

let pass = 0;
function ok(c: boolean, m: string) {
  if (!c) throw new Error(`FAIL ${m}`);
  pass++;
}
const mk = (tag: string): (() => SessionEntry) => () =>
  ({ term: { tag } as any, sinceId: 0, lastAppliedId: 0 });

// touch creates and is retrievable
{
  const c = new SessionCache(3);
  const e = c.touch('term-1', mk('1'));
  ok(c.get('term-1') === e, 'touch stores entry');
  ok(c.has('term-1'), 'has returns true');
}

// LRU evicts least-recently-touched beyond cap
{
  const c = new SessionCache(2);
  c.touch('a', mk('a'));
  c.touch('b', mk('b'));
  c.touch('a', mk('a2')); // a becomes most-recent; make ignored (already present)
  c.touch('c', mk('c')); // evicts b (least recent)
  ok(c.has('a'), 'a retained (recently touched)');
  ok(c.has('c'), 'c retained (newest)');
  ok(!c.has('b'), 'b evicted');
  ok(c.get('a')!.term.tag === 'a', 'existing entry not rebuilt on re-touch');
}

// delete removes
{
  const c = new SessionCache(3);
  c.touch('x', mk('x'));
  c.delete('x');
  ok(!c.has('x'), 'delete removes');
}

// nextTermId picks max+1 (handles gaps and non-matching ids)
{
  ok(nextTermId([]) === 'term-1', 'empty -> term-1');
  ok(nextTermId(['term-1', 'term-3']) === 'term-4', 'gap -> max+1');
  ok(nextTermId(['default', 'term-2']) === 'term-3', 'ignores non-term ids');
}

console.log(`\n  ${pass} assertions passed\n`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun run src/sessionCache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sessionCache.ts`**

Create `apps/mobile/src/sessionCache.ts`:

```ts
import type { TerminalEmulator } from './terminal';

export interface SessionEntry {
  term: TerminalEmulator;
  sinceId: number;
  lastAppliedId: number;
}

// LRU cache of terminal emulators. Only the active session has a live WS; cached
// background emulators are frozen. The active session is always most-recently
// touched, so it is never the eviction victim (cap >= 1).
export class SessionCache {
  private map = new Map<string, SessionEntry>();
  private order: string[] = []; // most-recent first
  constructor(private cap = 3) {}

  get(id: string): SessionEntry | undefined {
    return this.map.get(id);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }

  // Get-or-create `id`, mark it most-recently-used, evict beyond cap.
  touch(id: string, make: () => SessionEntry): SessionEntry {
    let e = this.map.get(id);
    if (!e) {
      e = make();
      this.map.set(id, e);
    }
    this.order = [id, ...this.order.filter((x) => x !== id)];
    while (this.order.length > this.cap) {
      const victim = this.order.pop()!;
      this.map.delete(victim);
    }
    return e;
  }

  delete(id: string): void {
    this.map.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  ids(): string[] {
    return [...this.order];
  }
}

export function nextTermId(existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    const m = /^term-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `term-${max + 1}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun run src/sessionCache.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/mobile && bun x tsc --noEmit
git add apps/mobile/src/sessionCache.ts apps/mobile/src/sessionCache.test.ts
git commit -m "feat(mobile): LRU session cache + nextTermId (pure, tested)"
```

---

## Task 4: Client — `SessionDrawer` component

**Files:**
- Create: `apps/mobile/src/SessionDrawer.tsx`

**Interfaces:**
- Consumes: nothing from other tasks (presentational).
- Produces:
  ```ts
  interface DrawerSession { id: string; status: 'running' | 'stopped'; last_output_at: string | null }
  interface SessionDrawerProps {
    visible: boolean;
    sessions: DrawerSession[];
    activeId: string;
    onSelect: (id: string) => void;
    onNew: () => void;
    onKill: (id: string) => void;
    onClose: () => void;
  }
  export function SessionDrawer(props: SessionDrawerProps): JSX.Element | null;
  ```
- Activity rule: a session is "active" (green dot) if `last_output_at` is within the last 10s; else "idle". The `activeId` row shows a filled accent dot regardless.

- [ ] **Step 1: Implement the component**

Create `apps/mobile/src/SessionDrawer.tsx`:

```tsx
import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Pressable } from 'react-native';

export interface DrawerSession {
  id: string;
  status: 'running' | 'stopped';
  last_output_at: string | null;
}

interface SessionDrawerProps {
  visible: boolean;
  sessions: DrawerSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onClose: () => void;
}

function isRecentlyActive(ts: string | null): boolean {
  if (!ts) return false;
  // SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS"; treat as UTC.
  const t = Date.parse(ts.replace(' ', 'T') + 'Z');
  return !Number.isNaN(t) && Date.now() - t < 10_000;
}

export function SessionDrawer({
  visible,
  sessions,
  activeId,
  onSelect,
  onNew,
  onKill,
  onClose,
}: SessionDrawerProps) {
  if (!visible) return null;
  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.panel}>
        <Text style={styles.title}>Terminals</Text>
        <ScrollView style={styles.list}>
          {sessions.map((s) => {
            const active = s.id === activeId;
            const live = active || isRecentlyActive(s.last_output_at);
            return (
              <View key={s.id} style={[styles.row, active && styles.rowActive]}>
                <TouchableOpacity style={styles.rowMain} onPress={() => onSelect(s.id)}>
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: s.status === 'stopped' ? '#64748b' : live ? '#34d399' : '#334155' },
                    ]}
                  />
                  <Text style={[styles.name, active && styles.nameActive]}>{s.id}</Text>
                  {s.status === 'stopped' && <Text style={styles.stopped}>stopped</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.kill} onPress={() => onKill(s.id)}>
                  <Text style={styles.killText}>✕</Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
        <TouchableOpacity style={styles.newBtn} onPress={onNew}>
          <Text style={styles.newBtnText}>+ New terminal</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', zIndex: 100 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  panel: {
    width: 260,
    backgroundColor: '#0b0f19',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.1)',
    paddingTop: 56,
    paddingHorizontal: 12,
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  title: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    marginBottom: 4,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  rowActive: { backgroundColor: 'rgba(99,102,241,0.15)' },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  name: { color: '#cbd5e1', fontFamily: 'Courier', fontSize: 13 },
  nameActive: { color: '#818cf8', fontWeight: '700' },
  stopped: { color: '#64748b', fontSize: 10, marginLeft: 8 },
  kill: { padding: 10 },
  killText: { color: '#f87171', fontSize: 14 },
  newBtn: {
    marginVertical: 12,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#4f46e5',
    alignItems: 'center',
  },
  newBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
```

Note: `fontFamily: 'Courier'` matches the app's iOS mono; acceptable for the drawer on Android too (falls back). Keep as-is for v1.

- [ ] **Step 2: Typecheck**

Run: `cd apps/mobile && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/SessionDrawer.tsx
git commit -m "feat(mobile): SessionDrawer slide-over component"
```

---

## Task 5: Client — integrate multi-session into `App.tsx`

This task converts `App.tsx` from a single fixed session to the cache-backed multi-session model. It has no automated tests (RN UI); it ends with on-device verification. Make the edits in order, typecheck after each, then run the manual checklist.

**Files:**
- Modify: `apps/mobile/App.tsx`

**Interfaces:**
- Consumes: `SessionCache`, `nextTermId`, `SessionEntry` (Task 3); `SessionDrawer`, `DrawerSession` (Task 4); `listSessions` shape from `GET /api/sessions` (Task 1) = `{ id, command, status, created_at, last_output_at }[]`.

- [ ] **Step 1: Imports + new state/refs**

Add imports near the other imports:

```tsx
import { SessionCache, nextTermId, type SessionEntry } from './src/sessionCache';
import { SessionDrawer, type DrawerSession } from './src/SessionDrawer';
```

Replace the single-session id storage key usage: keep `KEY_SESSION_ID` but repurpose it to persist the **active** id (`tether_active_id` semantics are fine under the old key).

Remove the standalone `sinceId` / `lastAppliedId` refs (they move into cache entries) and the single `term` ref. Replace with:

```tsx
const cache = useRef(new SessionCache(3)).current;
const [activeId, setActiveId] = useState('term-1');
const activeIdRef = useRef('term-1'); // for stale-closure-free access in ws handlers
const [drawerOpen, setDrawerOpen] = useState(false);
const [drawerSessions, setDrawerSessions] = useState<DrawerSession[]>([]);
```

Add a helper to get/create the active entry, sized to the current grid:

```tsx
const entryFor = (id: string): SessionEntry =>
  cache.touch(id, () => ({ term: new TerminalEmulator(numCols || 80, numRows || 24), sinceId: 0, lastAppliedId: 0 }));
```

> Note: `numCols`/`numRows` are computed later in the component; move the sizing block (the `useWindowDimensions` + `numCols`/`numRows` computation) ABOVE `entryFor` so it is in scope, or read from a ref. Simplest: keep the sizing block where it is (top, already moved there in a prior change) — confirm `numCols`/`numRows` are declared before `entryFor`.

- [ ] **Step 2: Typecheck (expect errors referencing removed refs)**

Run: `cd apps/mobile && bun x tsc --noEmit`
Expected: FAIL — references to old `term.current`, `sinceId.current`, `lastAppliedId.current`, `sessionId`. These are fixed in the next steps.

- [ ] **Step 3: Rewrite `connect`, `scheduleRender`, `resetTerminal` for the active entry**

Replace the body of `scheduleRender` to snapshot the active entry's term:

```tsx
const scheduleRender = () => {
  if (renderScheduled.current) return;
  renderScheduled.current = true;
  setTimeout(() => {
    renderScheduled.current = false;
    const e = cache.get(activeIdRef.current);
    if (!e) return;
    setScreen(e.term.getSnapshot());
    if (e.term.mouseOn !== mouseOnRef.current) {
      mouseOnRef.current = e.term.mouseOn;
      setMouseOn(e.term.mouseOn);
    }
  }, 33);
};
```

Replace `connect` to use the active entry and its per-session `sinceId`/`lastAppliedId`:

```tsx
const connect = () => {
  disconnect();
  const id = activeIdRef.current;
  const e = entryFor(id);
  setConnectionStatus('connecting');
  const wsUrl = `ws://${serverIp}:${port}/api/ws?sessionId=${id}&sinceId=${e.sinceId}&cols=${numCols}&rows=${numRows}`;
  const socket = new WebSocket(wsUrl);

  socket.onopen = () => setConnectionStatus('connected');

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      const ent = cache.get(id);
      if (!ent) return;
      if (msg.type === 'output') {
        if (msg.id) {
          if (msg.id <= ent.lastAppliedId) return;
          ent.lastAppliedId = msg.id;
          ent.sinceId = msg.id;
        }
        ent.term.write(msg.chunk);
        if (id === activeIdRef.current) scheduleRender();
      } else if (msg.type === 'exit') {
        ent.term.write(`\r\n\x1b[31m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
        if (id === activeIdRef.current) scheduleRender();
      }
    } catch (err) {
      console.error('ws message error:', err);
    }
  };

  socket.onclose = () => {
    setConnectionStatus('disconnected');
    ws.current = null;
    if (!isConfiguring && activeIdRef.current === id) {
      reconnectTimeout.current = setTimeout(connect, 3000);
    }
  };
  socket.onerror = (e2) => console.log('ws error:', e2);
  ws.current = socket;
};
```

Replace `resetTerminal` (used by hard reset):

```tsx
const resetTerminal = () => {
  const e = cache.get(activeIdRef.current);
  if (e) {
    e.term.reset();
    e.sinceId = 0;
    e.lastAppliedId = 0;
    setScreen(e.term.getSnapshot());
  }
};
```

- [ ] **Step 4: Add `switchTo`, `newTerminal`, `killSession`; keep `activeIdRef` in sync**

Add near the command handlers:

```tsx
const switchTo = (id: string) => {
  setDrawerOpen(false);
  if (id === activeIdRef.current && ws.current) return;
  disconnect();
  activeIdRef.current = id;
  setActiveId(id);
  AsyncStorage.setItem(KEY_SESSION_ID, id);
  const e = entryFor(id); // creates fresh if uncached; resizes handled by effect
  setScreen(e.term.getSnapshot()); // instant paint of last-known screen
  autoScroll.current = true;
  connect();
};

const newTerminal = () => {
  const existing = drawerSessions.map((s) => s.id);
  switchTo(nextTermId(existing.length ? existing : cache.ids()));
};

const killActiveOr = async (id: string) => {
  try {
    await fetch(`http://${serverIp}:${port}/api/sessions/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch {}
  cache.delete(id);
  const remaining = drawerSessions.filter((s) => s.id !== id).map((s) => s.id);
  await refreshSessions();
  if (id === activeIdRef.current) switchTo(remaining[0] ?? 'term-1');
};
```

Keep `activeIdRef` synced when `activeId` changes (belt-and-suspenders):

```tsx
useEffect(() => {
  activeIdRef.current = activeId;
}, [activeId]);
```

- [ ] **Step 5: Session-list poll + refresh helper**

Add:

```tsx
const refreshSessions = async () => {
  try {
    const res = await fetch(`http://${serverIp}:${port}/api/sessions`);
    const rows = (await res.json()) as DrawerSession[];
    setDrawerSessions(rows);
  } catch {}
};

// Poll the session list every 4s while foregrounded.
useEffect(() => {
  if (isConfiguring) return;
  refreshSessions();
  const iv = setInterval(refreshSessions, 4000);
  return () => clearInterval(iv);
}, [isConfiguring, serverIp, port]);
```

Update the connection effect to depend on `activeId` instead of the old `sessionId`:

```tsx
useEffect(() => {
  if (!isConfiguring) connect();
  else disconnect();
  return () => disconnect();
}, [isConfiguring, activeId]);
```

Update the resize effect to send to the active session (it already uses `numCols`/`numRows`) — no id change needed, but ensure it calls `cache.get(activeIdRef.current)?.term.resize(numCols, numRows)` instead of the old single `term.current`:

```tsx
useEffect(() => {
  cache.get(activeIdRef.current)?.term.resize(numCols, numRows);
  if (ws.current && connectionStatus === 'connected') {
    ws.current.send(JSON.stringify({ type: 'resize', cols: numCols, rows: numRows }));
  }
  scheduleRender();
}, [numCols, numRows, connectionStatus, activeId]);
```

- [ ] **Step 6: Load active id on mount; header drawer button; render drawer**

In `loadConfig`, replace `savedSession` handling to set the active id:

```tsx
if (savedSession) {
  setActiveId(savedSession);
  activeIdRef.current = savedSession;
}
```

In the header (terminal screen), add a `≡` button on the left of the title and show the active id. Before the `<View style={styles.headerInfo}>` block, add:

```tsx
<TouchableOpacity style={styles.headerBtn} onPress={() => { refreshSessions(); setDrawerOpen(true); }}>
  <Text style={styles.headerBtnText}>≡</Text>
</TouchableOpacity>
```

Change the header title/subtitle to show the active terminal:

```tsx
<Text style={styles.headerTitle}>{activeId}</Text>
<Text style={styles.headerSubtitle}>{serverIp}:{port}</Text>
```

Render the drawer inside the terminal screen (e.g., right after the `<KeyboardAvoidingView ...>` opening for the terminal view, or as a sibling near the root of that branch):

```tsx
<SessionDrawer
  visible={drawerOpen}
  sessions={drawerSessions}
  activeId={activeId}
  onSelect={switchTo}
  onNew={newTerminal}
  onKill={killActiveOr}
  onClose={() => setDrawerOpen(false)}
/>
```

- [ ] **Step 7: Remove the Session Name field from Config**

In the Config screen, delete the "Session Name" `<Text>`/`<TextInput>` block (the one bound to `sessionId`/`setSessionId`). Config now shows Server IP + Port only. Remove any leftover `sessionId`/`setSessionId` state that is no longer referenced (the active id is `activeId`).

- [ ] **Step 8: Typecheck**

Run: `cd apps/mobile && bun x tsc --noEmit`
Expected: PASS. Fix any remaining references to removed `sessionId`, `term.current`, `sinceId.current`, `lastAppliedId.current`.

- [ ] **Step 9: Emulator + cache tests still green**

Run: `cd apps/mobile && bun run src/terminal.test.ts && bun run src/sessionCache.test.ts`
Expected: `16 assertions passed` and the sessionCache assertions pass.

- [ ] **Step 10: Manual device/sim verification**

Start server (`bun dev:server`) + Metro (`bun dev:mobile`), open the app. Verify:
1. App opens to `term-1`; a shell prompt in `~` appears.
2. `≡` opens the drawer; `term-1` listed, active dot.
3. `+ New terminal` → `term-2` opens, fresh bash; drawer shows both.
4. Run `sleep 30 && echo DONE` in `term-2`, switch to `term-1`, wait, switch back → `DONE` present (catch-up replay), switch-back paints instantly.
5. Run a Claude Code session in one tab, switch away and back → renders correctly, no `�`, caret/scroll intact.
6. Kill a background tab from the drawer → disappears; its shell terminates server-side.
7. Kill the active tab → switches to another; killing the last → auto-creates `term-1`.
8. Cold-restart the app → reopens to the last active tab; drawer lists live sessions.

- [ ] **Step 11: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): multi-terminal tabs (drawer, LRU cache, switch/new/kill)"
```

---

## Task 6: Update docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Note multi-session model**

Update the "Data flow" / conventions in `CLAUDE.md` to state: the mobile app is multi-session (drawer-based tabs); the server session list is the source of truth; `terminal_logs` is capped per session (2000 rows). One or two lines.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note multi-terminal model + log cap"
```

---

## Self-Review

**Spec coverage:**
- Server `last_output_at` → Task 1 ✓
- Log cap → Task 2 ✓
- LRU emulator cache + nextTermId → Task 3 ✓
- Drawer UI → Task 4 ✓
- Active-id state, switch/new/kill, poll, persistence, Config cleanup, header ≡ → Task 5 ✓
- Detach-on-leave (no server call on switch) → Task 5 `switchTo` (only `disconnect()`, no kill) ✓
- Kill semantics incl. auto-create last → Task 5 `killActiveOr` ✓
- Out-of-scope items (notifications, rename, web) → intentionally omitted ✓

**Placeholder scan:** No TBD/TODO; all steps carry concrete code or exact commands. The one narrative note (Task 5 Step 1) about ordering the sizing block references concrete symbols (`numCols`/`numRows`).

**Type consistency:** `SessionEntry` fields (`term`, `sinceId`, `lastAppliedId`) used identically in Tasks 3 and 5. `SessionCache.touch(id, make)` signature matches usage. `DrawerSession` (`id`,`status`,`last_output_at`) matches `listSessions()`'s `SessionRow` output shape. `nextTermId(string[])` matches call sites.

# Terminal Experience Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 13 confirmed terminal-experience defects from the 2026-07-01 code review: server replay integrity, VT emulator fidelity (wide chars, DEC line drawing, resize), and mobile input/UX (scroll pinning, key repeat, reconnect race, cursor blink).

**Architecture:** Three independent layers, fixed bottom-up. Server (`apps/server/src/server/`): a prune watermark in SQLite lets the WS gateway detect replay gaps and tell the client to reset; PTY dims get clamped; slow sockets get closed (reconnect replays). Emulator (`apps/mobile/src/terminal.ts`): pure-TS, fully unit-testable — wide-char cells, DEC special graphics charset, scrollback-preserving row resize. Client (`apps/mobile/App.tsx`): handles the new `reset` message, guards the reconnect race, pins scroll correctly, adds key repeat / Del / cursor blink, deletes dead history code.

**Tech Stack:** Bun ≥ 1.3.14 (server PTY), bun:sqlite, Hono, Expo RN 0.86 / React 19, Biome.

## Global Constraints

- Formatting: Biome — 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` (repo root) before every server commit; `bun lint` before mobile commits.
- SQLite: `$name` named params only. Schema changes ONLY by appending to the `migrations` array in `db.ts` — never edit an applied migration.
- Tests are plain assert scripts (no test framework): `ok()`/`eq()` helpers, run with `bun run <file>`. Follow the existing style in `apps/server/src/server/db.test.ts` and `apps/mobile/src/terminal.test.ts`.
- db.test.ts must run against a throwaway DB: `TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts` (cwd `apps/server`).
- Emulator tests: `bun run src/terminal.test.ts` (cwd `apps/mobile`).
- Typecheck: `bun --cwd apps/server typecheck` and `cd apps/mobile && npx tsc --noEmit`.
- No new dependencies anywhere.
- Do not add Co-Authored-By trailers to commits.
- WS protocol today: server→client `{type:'output'|'exit'}`, client→server `{type:'input'|'resize'}`. This plan adds server→client `{type:'reset'}` (Task 2/9).

## Findings deliberately NOT fixed (verified false or by-design — do not "fix" these)

- Replay/subscribe race in `app.ts` onOpen: the block is synchronous; PTY events cannot interleave. No change.
- Client-side UTF-8 split corruption: server decodes with a streaming `TextDecoder` (`pty.ts:59-79`); client receives whole code points. Only the exit-flush tail is real (Task 4).
- Tab long-press sending `\x1b[Z`: deliberate Shift+Tab feature.
- No horizontal scroll: by design — cols auto-fit the viewport and the PTY is resized to match.
- Scroll region reset on resize: xterm does the same. Scrollback reflow: xterm doesn't reflow either. Skipped.
- OSC 0/2/8/52 payloads dropped: no consumer in the UI; skipped.
- Cursor "drift" in `getSnapshot`: coordinates are consistent in content space. False.
- Session-switch ID validation: connecting to a fresh ID auto-starts a session — that IS `newTerminal`. By design.
- Shift+arrow/Home/End modifiers: no hardware-Shift detection on soft keyboards and marginal value on mobile; the shell owns selection. Skipped.
- IME zero-width-sentinel reset: works on the target devices; touch only if a concrete IME bug is reported.
- Transient wrong height during keyboard animation: `onLayout` → `numRows` is already event-driven and self-corrects one frame later. Cosmetic, skipped.
- Mouse-wheel `?? 80` fallback for a missing cache entry: defensive dead branch, harmless. Skipped.

---

### Task 1: Prune watermark in DB (`pruned_before` column)

**Files:**
- Modify: `apps/server/src/server/db.ts`
- Test: `apps/server/src/server/db.test.ts`

**Interfaces:**
- Consumes: existing `pruneLogs(sessionId, cap)`, `migrations` array, `Session` interface.
- Produces: `Session.pruned_before: number` (highest log id ever pruned for that session, 0 if never); `pruneLogs` now updates it. Task 2 reads it via `getSession()`. Also `resetRunningSessions(): void` used by Task 4.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/server/db.test.ts` (before the final `console.log`):

```ts
// pruneLogs records the high-water mark of pruned ids
{
  upsertSession('term-wm', 'bash', 'running');
  for (let i = 0; i < 30; i++) addTerminalLog('term-wm', `w${i}`);
  const before = getLogs('term-wm', 0);
  pruneLogs('term-wm', 10);
  const after = getLogs('term-wm', 0);
  const sess = getSession('term-wm');
  ok(after.length === 10, 'watermark prune keeps 10 rows');
  ok(sess!.pruned_before === before[before.length - 11].id, 'pruned_before = highest pruned id');

  // pruning again with nothing to prune must not lower the watermark
  pruneLogs('term-wm', 10);
  ok(getSession('term-wm')!.pruned_before === sess!.pruned_before, 'watermark stable when no-op');
}

// resetRunningSessions marks every running session stopped
{
  upsertSession('term-orphan', 'bash', 'running');
  resetRunningSessions();
  const row = listSessions().find((r) => r.id === 'term-orphan');
  ok(row!.status === 'stopped', 'orphan reset marks running sessions stopped');
}
```

Update the import at the top of the test file:

```ts
import {
  addTerminalLog,
  getLogs,
  getSession,
  listSessions,
  pruneLogs,
  renameSession,
  resetRunningSessions,
  upsertSession,
} from './db';
```

- [ ] **Step 2: Run tests to verify they fail**

Run (cwd `apps/server`): `TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts`
Expected: FAIL — `resetRunningSessions` not exported / `pruned_before` undefined.

- [ ] **Step 3: Implement**

In `apps/server/src/server/db.ts`:

Append to the `migrations` array (never edit existing entries):

```ts
  {
    version: 3,
    name: 'pruned_watermark',
    up: `ALTER TABLE sessions ADD COLUMN pruned_before INTEGER NOT NULL DEFAULT 0;`,
  },
```

Add `pruned_before` to the `Session` interface:

```ts
export interface Session {
  id: string;
  command: string;
  status: 'running' | 'stopped';
  created_at: string;
  name: string | null;
  pruned_before: number;
}
```

Replace `pruneLogs` with a version that records the cutoff:

```ts
export function pruneLogs(sessionId: string, cap = LOG_CAP) {
  const cut = db
    .query(
      `SELECT id FROM terminal_logs WHERE session_id = $id
       ORDER BY id DESC LIMIT 1 OFFSET $cap`,
    )
    .get({ $id: sessionId, $cap: cap }) as { id: number } | null;
  if (!cut) return;
  db.query('DELETE FROM terminal_logs WHERE session_id = $id AND id <= $cut').run({
    $id: sessionId,
    $cut: cut.id,
  });
  // Watermark lets the WS gateway detect a client whose sinceId predates the
  // prune (gap in replay) and tell it to reset instead of rendering a hole.
  db.query(
    'UPDATE sessions SET pruned_before = $cut WHERE id = $id AND pruned_before < $cut',
  ).run({ $id: sessionId, $cut: cut.id });
}
```

Add near `setSessionStatus`:

```ts
// Called once at boot: any session still marked running belonged to a previous
// server process — its PTY is gone.
export function resetRunningSessions() {
  db.query(`UPDATE sessions SET status = 'stopped' WHERE status = 'running'`).run();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (cwd `apps/server`): `TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts`
Expected: all assertions pass (count grows by 4).
Also run: `bun --cwd apps/server typecheck` — expected clean.

- [ ] **Step 5: Format + commit**

```bash
cd /home/samuelloranger/sites/tether && bun format
git add apps/server/src/server/db.ts apps/server/src/server/db.test.ts
git commit -m "feat(server): track pruned-log watermark per session + boot-time orphan reset"
```

---

### Task 2: WS gateway sends `reset` on replay gap

**Files:**
- Modify: `apps/server/src/server/app.ts`

**Interfaces:**
- Consumes: `getSession(id).pruned_before` (Task 1).
- Produces: server→client message `{type:'reset'}` sent BEFORE replay rows whenever the client's `sinceId` predates pruned data. Task 9 implements the client side.

- [ ] **Step 1: Implement**

In `apps/server/src/server/app.ts`, inside `onOpen`'s `setTimeout`, between `startSession(...)` (step 1) and the `getLogs` replay (step 2), insert:

```ts
            // 1b. If the client's sinceId predates pruned rows, the replay has a
            // hole — tell the client to wipe its emulator before the replay.
            const sess = getSession(sessionId);
            if (sinceId > 0 && sess && sinceId < sess.pruned_before) {
              ws.send(JSON.stringify({ type: 'reset' }));
            }
```

`getSession` is already exported from `./db`; add it to the existing import list in app.ts:

```ts
import { getLogs, getSession, listSessions, renameSession } from './db';
```

(Note: rows ≤ `pruned_before` are deleted, so `getLogs(sessionId, sinceId)` with a stale `sinceId` already returns every surviving row — no query change needed.)

- [ ] **Step 2: Verify**

Run: `bun --cwd apps/server typecheck` — expected clean.

Runtime check (server must be Bun ≥ 1.3.14):

```bash
cd /home/samuelloranger/sites/tether/apps/server
TETHER_DB_PATH=/tmp/tether-gap.db bun run src/server/index.ts &
sleep 1
# create a session and force a prune by writing > 2000 chunks
curl -s -XPOST localhost:8085/api/sessions/start -H 'content-type: application/json' -d '{"id":"gap"}'
# generate enough output to prune (yes emits fast)
curl -s "localhost:8085/api/sessions/gap/logs?sinceId=0" | head -c 200
# connect with sinceId=1 (guaranteed below watermark once pruning ran) and
# confirm the first frame is {"type":"reset"}:
bun -e 'const w=new WebSocket("ws://localhost:8085/api/ws?sessionId=gap&sinceId=1");w.onmessage=(m)=>{console.log(String(m.data).slice(0,40));w.close();process.exit(0)}'
kill %1
```

Expected: first printed frame is `{"type":"reset"}` *if* pruning has occurred (needs >2000 log rows — drive it by sending `{type:'input'}` of `seq 1 3000\r` first, or lower `LOG_CAP` locally for the check and revert). If pruning hasn't occurred, no reset frame — that's correct too.

- [ ] **Step 3: Format + commit**

```bash
cd /home/samuelloranger/sites/tether && bun format
git add apps/server/src/server/app.ts
git commit -m "fix(server): send reset frame when client sinceId predates pruned logs"
```

---

### Task 3: Clamp PTY dimensions + apply size on attach

**Files:**
- Modify: `apps/server/src/server/pty.ts`
- Modify: `apps/server/src/server/app.ts`
- Test: `apps/server/src/server/pty.dims.test.ts` (new)

**Interfaces:**
- Consumes: existing `startSession` / `resizeSession` signatures (unchanged).
- Produces: `clampDims(cols: unknown, rows: unknown): { cols: number; rows: number }` exported from `pty.ts`; `startSession` and `resizeSession` clamp internally; the WS gateway resizes an already-running session to the connecting client's size.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/server/pty.dims.test.ts`:

```ts
// Run: bun run src/server/pty.dims.test.ts
// Pure-function test only — does not spawn a PTY.
import { clampDims } from './pty';

let pass = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${msg}\n  expected ${b}\n  got      ${a}`);
  pass++;
}

eq(clampDims(80, 24), { cols: 80, rows: 24 }, 'passthrough');
eq(clampDims('120', '40'), { cols: 120, rows: 40 }, 'numeric strings');
eq(clampDims(Number.NaN, undefined), { cols: 80, rows: 24 }, 'NaN/undefined -> defaults');
eq(clampDims(-5, 0), { cols: 2, rows: 2 }, 'floor at 2');
eq(clampDims(99999, 99999), { cols: 500, rows: 200 }, 'ceiling');
eq(clampDims(80.9, 24.9), { cols: 80, rows: 24 }, 'floats floored');

console.log(`\n  ${pass} assertions passed\n`);
```

- [ ] **Step 2: Run test to verify it fails**

Run (cwd `apps/server`): `TETHER_DB_PATH=/tmp/tether-dims-$$.db bun run src/server/pty.dims.test.ts`
(env var because importing `pty.ts` transitively opens the DB via `db.ts`)
Expected: FAIL — `clampDims` is not exported.

- [ ] **Step 3: Implement**

In `apps/server/src/server/pty.ts`, above `startSession`:

```ts
// PTY dims from the network are untrusted: NaN/0/huge values wedge or crash the
// terminal. Clamp to a sane envelope.
export function clampDims(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = Math.floor(Number(cols));
  const r = Math.floor(Number(rows));
  return {
    cols: Number.isFinite(c) ? Math.min(500, Math.max(2, c)) : 80,
    rows: Number.isFinite(r) ? Math.min(200, Math.max(2, r)) : 24,
  };
}
```

At the top of `startSession`, replace the direct use of the `cols`/`rows` params:

```ts
export function startSession(
  id: string,
  command: string = process.env.SHELL || 'bash',
  cols: number = 80,
  rows: number = 24,
) {
  const dims = clampDims(cols, rows);
  if (instances.has(id)) {
    return instances.get(id)!;
  }
```

…and in the `Bun.spawn` options use the clamped values:

```ts
    terminal: {
      cols: dims.cols,
      rows: dims.rows,
```

In `resizeSession`, clamp before applying:

```ts
export function resizeSession(id: string, cols: number, rows: number) {
  const instance = instances.get(id);
  if (instance && instance.process.terminal) {
    const dims = clampDims(cols, rows);
    try {
      instance.process.terminal.resize(dims.cols, dims.rows);
      return true;
    } catch (e) {
      console.error(`Failed to resize terminal for session "${id}":`, e);
    }
  }
  return false;
}
```

In `apps/server/src/server/app.ts` `onOpen`, immediately after the `startSession(...)` call, add one line so an EXISTING session adopts the connecting client's size (startSession early-returns for running sessions and ignores its cols/rows args):

```ts
            startSession(sessionId, process.env.SHELL || 'bash', cols, rows);
            resizeSession(sessionId, cols, rows);
```

(`resizeSession` is already imported in app.ts. The `onMessage` resize path needs no change — it now clamps inside `resizeSession`.)

- [ ] **Step 4: Run tests to verify they pass**

Run (cwd `apps/server`): `TETHER_DB_PATH=/tmp/tether-dims-$$.db bun run src/server/pty.dims.test.ts`
Expected: `6 assertions passed`.
Also: `bun --cwd apps/server typecheck` — clean.

- [ ] **Step 5: Format + commit**

```bash
cd /home/samuelloranger/sites/tether && bun format
git add apps/server/src/server/pty.ts apps/server/src/server/app.ts apps/server/src/server/pty.dims.test.ts
git commit -m "fix(server): clamp PTY dims from network; resize running session on WS attach"
```

---

### Task 4: Flush UTF-8 decoder tail on exit + orphan reset at boot

**Files:**
- Modify: `apps/server/src/server/pty.ts`
- Modify: `apps/server/src/server/index.ts`

**Interfaces:**
- Consumes: `resetRunningSessions()` from Task 1; the per-session `decoder` already in `startSession`.
- Produces: no new exports. Final partial multi-byte char is logged + broadcast before the exit event; boot marks stale `running` rows `stopped`.

- [ ] **Step 1: Implement decoder flush**

In `apps/server/src/server/pty.ts`, at the top of the `proc.exited.then((code) => { ... })` handler, before `upsertSession(id, command, 'stopped')`:

```ts
  proc.exited.then((code) => {
    // Flush any buffered partial multi-byte sequence the streaming decoder is
    // still holding (PTY died mid-emoji) so the tail isn't silently dropped.
    const tail = decoder.decode();
    if (tail) {
      const logId = addTerminalLog(id, tail);
      const live = instances.get(id);
      if (live) {
        for (const sub of live.subscribers) {
          try {
            sub({ type: 'output', chunk: tail, id: logId });
          } catch {}
        }
      }
    }
    console.log(`PTY process for session "${id}" exited with code ${code}`);
```

- [ ] **Step 2: Implement boot-time orphan reset**

In `apps/server/src/server/index.ts`, before `Bun.serve`:

```ts
import { websocket } from 'hono/bun';
import { app } from './app';
import { resetRunningSessions } from './db';

const PORT = Number(process.env.TETHER_PORT ?? 8085);

// A previous server process may have died with sessions still marked running;
// their PTYs are gone, so reflect reality before serving the session list.
resetRunningSessions();

console.log(`Tether server listening on :${PORT}`);
```

- [ ] **Step 3: Verify**

Run: `bun --cwd apps/server typecheck` — clean.
Run (cwd `apps/server`): `TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts` — still passes (regression check).

Runtime check for orphan reset:

```bash
cd /home/samuelloranger/sites/tether/apps/server
TETHER_DB_PATH=/tmp/tether-orphan.db bun run src/server/index.ts &
sleep 1
curl -s -XPOST localhost:8085/api/sessions/start -H 'content-type: application/json' -d '{"id":"orph"}' >/dev/null
kill -9 %1   # simulate crash: session row stays 'running'
TETHER_DB_PATH=/tmp/tether-orphan.db bun run src/server/index.ts &
sleep 1
curl -s localhost:8085/api/sessions | grep -o '"status":"[a-z]*"'
kill %1
```

Expected: `"status":"stopped"` for the orphaned session.

- [ ] **Step 4: Format + commit**

```bash
cd /home/samuelloranger/sites/tether && bun format
git add apps/server/src/server/pty.ts apps/server/src/server/index.ts
git commit -m "fix(server): flush decoder tail on PTY exit; mark orphaned sessions stopped at boot"
```

---

### Task 5: Close slow WebSocket clients (backpressure guard)

**Files:**
- Modify: `apps/server/src/server/app.ts`

**Interfaces:**
- Consumes: Hono `WSContext.raw` (Bun `ServerWebSocket`), which exposes `getBufferedAmount()`.
- Produces: no new exports. A subscriber whose socket has > 4 MB buffered gets closed; the client's normal reconnect + `sinceId` replay restores state.

- [ ] **Step 1: Implement**

In `apps/server/src/server/app.ts`, at the top of the `subscribeToSession` callback (inside `onOpen`), before the `if (data.type === 'output')` branch:

```ts
            unsubscribe = subscribeToSession(sessionId, (data) => {
              // ponytail: no queueing for slow clients — if the socket's send
              // buffer blows past 4MB, close it; reconnect replays via sinceId.
              const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
              if (raw?.getBufferedAmount && raw.getBufferedAmount() > 4_000_000) {
                try {
                  ws.close();
                } catch {}
                return;
              }
              try {
```

(The rest of the callback body is unchanged.)

- [ ] **Step 2: Verify**

Run: `bun --cwd apps/server typecheck` — clean.
Smoke: start the server (`TETHER_DB_PATH=/tmp/tether-bp.db bun run src/server/index.ts`), connect with the one-liner from Task 2 Step 2, type via `{type:'input'}` — normal output still flows (guard is a no-op for healthy sockets). Kill server.

- [ ] **Step 3: Format + commit**

```bash
cd /home/samuelloranger/sites/tether && bun format
git add apps/server/src/server/app.ts
git commit -m "fix(server): close WS clients whose send buffer exceeds 4MB"
```

---

### Task 6: Emulator — wide character (CJK/emoji) cell width

**Files:**
- Modify: `apps/mobile/src/terminal.ts`
- Test: `apps/mobile/src/terminal.test.ts`

**Interfaces:**
- Consumes: `putChar`, `Cell`, existing wrap logic.
- Produces: wide glyphs occupy 2 cells (second cell is `{ch: ''}` filler); cursor advances 2; DSR reports the correct column. No API change.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/terminal.test.ts` before the final `console.log`:

```ts
// 16. Wide chars (CJK/emoji) occupy two cells
{
  const t = new TerminalEmulator(10, 4);
  let reply = '';
  t.onReply = (d) => {
    reply = d;
  };
  t.write(`你好${E}[6n`); // 2 wide chars -> cursor col 5 (1-based)
  eq(line(t, 0), '你好', 'CJK text renders');
  eq(reply, `${E}[1;5R`, 'wide chars advance cursor by 2');
}

// 17. Wide char wraps instead of splitting at the right edge
{
  const t = new TerminalEmulator(4, 3);
  t.write('abc你'); // cx=3, width-2 char cannot fit in col 3 -> wraps
  eq(line(t, 0), 'abc', 'row 0 keeps narrow chars');
  eq(line(t, 1), '你', 'wide char wrapped whole to row 1');
}

// 18. Overwriting narrow-over-wide keeps column alignment
{
  const t = new TerminalEmulator(10, 4);
  t.write(`你${E}[1;1HX`); // overwrite first half of the wide char
  const row = line(t, 0);
  eq(row.startsWith('X'), true, 'narrow overwrite lands at col 1');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (cwd `apps/mobile`): `bun run src/terminal.test.ts`
Expected: FAIL on assertion 16 (`wide chars advance cursor by 2` — reply is `[1;3R`).

- [ ] **Step 3: Implement**

In `apps/mobile/src/terminal.ts`, add above the `TerminalEmulator` class:

```ts
// ponytail: coarse wcwidth — the wide CJK/Hangul/emoji blocks only; combining
// marks and ambiguous-width chars are treated as narrow. Upgrade to a full
// wcwidth table if East-Asian alignment bugs surface.
function charWidth(cp: number): 1 | 2 {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}
```

Replace `putChar`:

```ts
  private putChar(ch: string) {
    const w = charWidth(ch.codePointAt(0)!);
    if (this.cx + w > this.cols) {
      this.cx = 0;
      this.lineFeed();
    }
    this.screen[this.cy][this.cx] = { ch, ...this.pen };
    // Wide glyphs own two cells: the second is a zero-width filler so column
    // math (cursor addressing, erase) stays aligned. mergeRuns concats '' away.
    if (w === 2 && this.cx + 1 < this.cols) {
      this.screen[this.cy][this.cx + 1] = { ch: '', ...this.pen };
    }
    this.cx += w;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run (cwd `apps/mobile`): `bun run src/terminal.test.ts`
Expected: all assertions pass (previous 15 blocks + new ones — the count printed grows accordingly). Existing tests 1–15 must still pass.
Also: `cd apps/mobile && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "fix(mobile): wide CJK/emoji glyphs occupy two terminal cells"
```

---

### Task 7: Emulator — DEC special graphics charset (box drawing)

**Files:**
- Modify: `apps/mobile/src/terminal.ts`
- Test: `apps/mobile/src/terminal.test.ts`

**Interfaces:**
- Consumes: the `escInt` parser state (currently discards the designator byte), `putChar`, `ground`, `reset`.
- Produces: `ESC(0` / `ESC(B` switch G0, `ESC)0` / `ESC)B` switch G1, SO (0x0e) / SI (0x0f) select G1/G0; `j k l m n q t u v w x` etc. map to box-drawing glyphs while active. No API change.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/terminal.test.ts`:

```ts
// 19. DEC special graphics: ESC(0 maps jklmnqtuvwx to box glyphs, ESC(B restores
{
  const t = new TerminalEmulator(20, 4);
  t.write(`${E}(0lqk${E}(B done`);
  eq(line(t, 0), '┌─┐ done', 'DEC line-drawing on G0');
}

// 20. SO/SI shift between G0 and a DEC G1
{
  const t = new TerminalEmulator(20, 4);
  t.write(`${E})0plain\x0eq\x0fplain`); // designate G1=dec, SO, draw, SI
  eq(line(t, 0), 'plain─plain', 'SO selects DEC G1, SI restores G0');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (cwd `apps/mobile`): `bun run src/terminal.test.ts`
Expected: FAIL — line reads `lqk done` (literal letters).

- [ ] **Step 3: Implement**

In `apps/mobile/src/terminal.ts`, add above the class (near `charWidth`):

```ts
// DEC Special Graphics (ESC ( 0) — the VT100 line-drawing set TUIs use for
// borders (htop, less, dialog). Unmapped chars pass through.
const DEC_GRAPHICS: Record<string, string> = {
  '`': '◆', a: '▒', f: '°', g: '±', j: '┘', k: '┐', l: '┌', m: '└',
  n: '┼', o: '⎺', p: '⎻', q: '─', r: '⎼', s: '⎽', t: '├', u: '┤',
  v: '┴', w: '┬', x: '│', y: '≤', z: '≥', '{': 'π', '|': '≠', '}': '£', '~': '·',
};
```

Add instance fields (near `savedCx`/`savedCy`):

```ts
  private g0: 'ascii' | 'dec' = 'ascii';
  private g1: 'ascii' | 'dec' = 'ascii';
  private shiftOut = false; // SO selects G1, SI back to G0
  private escTarget: 'g0' | 'g1' | null = null;
```

In `reset()` add:

```ts
    this.g0 = 'ascii';
    this.g1 = 'ascii';
    this.shiftOut = false;
    this.escTarget = null;
```

In `esc()`, replace the `'(' ')' '*' '+'` case group:

```ts
      case '(':
      case ')':
        this.escTarget = ch === '(' ? 'g0' : 'g1';
        this.state = 'escInt';
        return;
      case '*':
      case '+':
        this.escTarget = null; // G2/G3 unsupported — consume designator only
        this.state = 'escInt';
        return;
```

In `write()`, replace the `escInt` case:

```ts
        case 'escInt': {
          if (this.escTarget) {
            const set = ch === '0' ? 'dec' : 'ascii';
            if (this.escTarget === 'g0') this.g0 = set;
            else this.g1 = set;
            this.escTarget = null;
          }
          this.state = 'ground';
          break;
        }
```

In `ground()`, add SO/SI handling before the `code >= 0x20` branch:

```ts
    } else if (code === 0x0e) {
      this.shiftOut = true; // SO
    } else if (code === 0x0f) {
      this.shiftOut = false; // SI
    } else if (code >= 0x20) {
```

In `putChar`, translate at the top (before the width computation from Task 6):

```ts
  private putChar(ch: string) {
    const active = this.shiftOut ? this.g1 : this.g0;
    if (active === 'dec') ch = DEC_GRAPHICS[ch] ?? ch;
    const w = charWidth(ch.codePointAt(0)!);
```

- [ ] **Step 4: Run tests to verify they pass**

Run (cwd `apps/mobile`): `bun run src/terminal.test.ts` — all pass, including tests 1–18.
Also: `cd apps/mobile && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "fix(mobile): DEC special-graphics charset so TUI box borders render"
```

---

### Task 8: Emulator — resize preserves bottom content via scrollback

**Files:**
- Modify: `apps/mobile/src/terminal.ts`
- Test: `apps/mobile/src/terminal.test.ts`

**Interfaces:**
- Consumes: `resize`, `scrollback`, `fitLine`.
- Produces: shrinking rows pushes TOP lines to scrollback (prompt at the bottom stays visible — this fires on every keyboard show/hide); growing pulls lines back. Alt screen truncates/pads as before. Scroll region still resets (matches xterm).

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/terminal.test.ts`:

```ts
// 21. Row shrink keeps the bottom (prompt) lines, moving top lines to scrollback
{
  const t = new TerminalEmulator(80, 5);
  t.write('one\r\ntwo\r\nthree\r\nfour\r\nprompt$');
  t.resize(80, 3);
  eq(screenText(t), 'one\ntwo\nthree\nfour\nprompt$', 'shrink loses nothing overall');
  // cursor must still sit on the prompt line: overwrite check
  t.write(' X');
  eq(screenText(t).endsWith('prompt$ X'), true, 'cursor tracked to the prompt after shrink');
}

// 22. Row grow pulls lines back out of scrollback
{
  const t = new TerminalEmulator(80, 3);
  t.write('a\r\nb\r\nc\r\nd\r\ne'); // rows a,b in scrollback; c,d,e on screen
  t.resize(80, 5);
  eq(screenText(t), 'a\nb\nc\nd\ne', 'grow restores scrollback rows to screen');
  t.write('!');
  eq(screenText(t).endsWith('e!'), true, 'cursor tracked after grow');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (cwd `apps/mobile`): `bun run src/terminal.test.ts`
Expected: FAIL on test 21 — current resize truncates from the bottom, `prompt$` line lost / cursor wrong.

- [ ] **Step 3: Implement**

Replace `resize` in `apps/mobile/src/terminal.ts`:

```ts
  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    // Rows: shrink moves TOP lines into scrollback so the bottom (where the
    // prompt lives) stays visible — this runs on every keyboard show/hide.
    // Grow pulls them back. Alt-screen apps repaint on SIGWINCH, so there we
    // just truncate/pad. No column reflow (xterm doesn't reflow either).
    while (this.screen.length > rows) {
      if (!this.inAlt && this.cy > 0) {
        const top = this.screen.shift()!;
        this.scrollback.push(top);
        if (this.scrollback.length > MAX_SCROLLBACK) this.scrollback.shift();
        this.cy--;
      } else {
        this.screen.pop();
      }
    }
    while (this.screen.length < rows) {
      if (!this.inAlt && this.scrollback.length > 0) {
        this.screen.unshift(this.scrollback.pop()!);
        this.cy++;
      } else {
        this.screen.push(blankLine(cols));
      }
    }
    this.rows = rows;
    this.screen = this.screen.map((l) => this.fitLine(l, cols));
    this.cx = Math.min(this.cx, cols - 1);
    this.cy = Math.min(this.cy, rows - 1);
    this.scrollTop = 0;
    this.scrollBot = rows - 1;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run (cwd `apps/mobile`): `bun run src/terminal.test.ts` — all pass including 1–20.
Also: `cd apps/mobile && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "fix(mobile): terminal resize preserves bottom rows via scrollback"
```

---

### Task 9: Client — handle `reset` frame + fix reconnect race

**Files:**
- Modify: `apps/mobile/App.tsx` (functions `connect` at ~line 285 and `disconnect` at ~line 330)

**Interfaces:**
- Consumes: server `{type:'reset'}` (Task 2); `SessionEntry {term, sinceId, lastAppliedId}`.
- Produces: on `reset`, the entry's emulator wipes and dedup counters zero BEFORE replay rows apply. Stale sockets can no longer clobber `ws.current` or schedule duplicate reconnect loops.

- [ ] **Step 1: Implement reset handling**

In `App.tsx` `connect()`, inside `socket.onmessage`, add a branch after the `exit` branch:

```ts
        } else if (msg.type === 'exit') {
          ent.term.write(`\r\n\x1b[31m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
          if (id === activeIdRef.current) scheduleRender();
        } else if (msg.type === 'reset') {
          // Server pruned past our sinceId — replay would have a hole. Wipe and
          // let the full replay that follows rebuild the screen from scratch.
          ent.term.reset();
          ent.sinceId = 0;
          ent.lastAppliedId = 0;
          if (id === activeIdRef.current) scheduleRender();
        }
```

- [ ] **Step 2: Implement stale-socket guards**

Still in `connect()`, replace `socket.onclose`:

```ts
    socket.onclose = () => {
      if (ws.current !== socket) return; // stale socket — a newer connection owns state
      setConnectionStatus('disconnected');
      ws.current = null;
      if (!isConfiguring && activeIdRef.current === id) {
        reconnectTimeout.current = setTimeout(connect, 3000);
      }
    };
```

And guard `onmessage` the same way — first line of the handler:

```ts
    socket.onmessage = (event) => {
      if (ws.current !== socket) return;
      try {
```

In `disconnect()`, null the ref BEFORE closing so the closing socket's `onclose` sees itself as stale:

```ts
  const disconnect = () => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    const s = ws.current;
    ws.current = null;
    if (s) s.close();
    setConnectionStatus('disconnected');
  };
```

- [ ] **Step 3: Verify**

Run: `cd apps/mobile && npx tsc --noEmit` — clean. Run `bun lint` from repo root — clean.
Manual (device/simulator, server running): connect, toggle airplane mode on/off twice rapidly — app must settle on exactly one `Connected` badge, no doubled output (doubled output = two live sockets).

- [ ] **Step 4: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/App.tsx
git commit -m "fix(mobile): handle server reset frame; guard stale-socket reconnect race"
```

---

### Task 10: Client — scroll pinning that doesn't fight the user

**Files:**
- Modify: `apps/mobile/App.tsx` (`onScroll` at ~line 675, FlatList props at ~line 812)

**Interfaces:**
- Consumes: `autoScroll` ref, FlatList `onScroll` / `onContentSizeChange`.
- Produces: auto-scroll re-arms only within 8px of the true bottom; ANY user drag immediately disarms it (no more viewport yank while reading history during streaming output).

- [ ] **Step 1: Implement**

Replace `onScroll`:

```ts
  const onScroll = (e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    // Re-arm auto-scroll only at the true bottom; 40px "near bottom" used to
    // yank the viewport away while reading history during streaming output.
    autoScroll.current = distanceFromBottom < 8;
  };
```

On the `FlatList`, add one prop next to `onScroll`:

```tsx
                onScroll={onScroll}
                onScrollBeginDrag={() => {
                  autoScroll.current = false;
                }}
```

- [ ] **Step 2: Verify**

`cd apps/mobile && npx tsc --noEmit` — clean.
Manual: run `yes | head -c 100000` on the shell, drag up mid-stream — the view must stay put; fling back to the bottom — pinning resumes.

- [ ] **Step 3: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/App.tsx
git commit -m "fix(mobile): only pin terminal scroll at true bottom; any drag unpins"
```

---

### Task 11: Client — arrow key repeat + Del key

**Files:**
- Modify: `apps/mobile/App.tsx` (`ArrowCluster` component at ~line 93, utility bar at ~line 1050)

**Interfaces:**
- Consumes: `ArrowCluster`'s `onArrow` prop; `sendInput`.
- Produces: holding an arrow repeats (350ms delay, then 60ms interval); a `Del` button sends `\x1b[3~` (forward delete). `onArrow` prop signature unchanged.

- [ ] **Step 1: Implement a repeat button and use it for the four arrow segments**

Above `ArrowCluster` in `App.tsx`, add:

```tsx
// Press-and-hold repeat for navigation keys: fire once on press, then repeat
// after 350ms at 60ms — mirrors hardware key-repeat.
function RepeatBtn({
  onFire,
  style,
  label,
  children,
}: {
  onFire: () => void;
  style: object;
  label: string;
  children: React.ReactNode;
}) {
  const delay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iv = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (delay.current) clearTimeout(delay.current);
    if (iv.current) clearInterval(iv.current);
    delay.current = null;
    iv.current = null;
  };
  useEffect(() => stop, []);
  return (
    <TouchableOpacity
      style={style}
      activeOpacity={0.6}
      onPressIn={() => {
        onFire();
        delay.current = setTimeout(() => {
          iv.current = setInterval(onFire, 60);
        }, 350);
      }}
      onPressOut={stop}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {children}
    </TouchableOpacity>
  );
}
```

Rewrite `ArrowCluster`'s four `TouchableOpacity`s as `RepeatBtn`s (same styles, same icons — only the wrapper changes; `onPress` becomes `onFire`):

```tsx
const ArrowCluster = React.memo(function ArrowCluster({
  onArrow,
}: {
  onArrow: (dir: 'A' | 'B' | 'C' | 'D') => void;
}) {
  return (
    <View style={styles.arrowCluster}>
      <RepeatBtn style={styles.arrowSeg} label="Arrow left" onFire={() => onArrow('D')}>
        <Feather name="chevron-left" size={18} color="#cbd5e1" />
      </RepeatBtn>
      <View style={styles.arrowVDivider} />
      <View style={styles.arrowMid}>
        <RepeatBtn style={styles.arrowMidHalf} label="Arrow up" onFire={() => onArrow('A')}>
          <Feather name="chevron-up" size={15} color="#cbd5e1" />
        </RepeatBtn>
        <View style={styles.arrowHDivider} />
        <RepeatBtn style={styles.arrowMidHalf} label="Arrow down" onFire={() => onArrow('B')}>
          <Feather name="chevron-down" size={15} color="#cbd5e1" />
        </RepeatBtn>
      </View>
      <View style={styles.arrowVDivider} />
      <RepeatBtn style={styles.arrowSeg} label="Arrow right" onFire={() => onArrow('C')}>
        <Feather name="chevron-right" size={18} color="#cbd5e1" />
      </RepeatBtn>
    </View>
  );
});
```

- [ ] **Step 2: Add the Del button**

In the utility bar, right after the Esc button (`sendInput('\x1b')` / “Esc”):

```tsx
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[3~')}>
                <Text style={styles.utilityBtnText}>Del</Text>
              </TouchableOpacity>
```

- [ ] **Step 3: Verify**

`cd apps/mobile && npx tsc --noEmit` — clean. `bun lint` — clean.
Manual: hold ← in a shell line — cursor walks; tap Del mid-word — forward-deletes (readline).

- [ ] **Step 4: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/App.tsx
git commit -m "feat(mobile): key repeat on held arrows; Del key in utility bar"
```

---

### Task 12: Client — blinking cursor

**Files:**
- Modify: `apps/mobile/App.tsx` (`runToStyle` ~line 44, `TermRow` ~line 65, `AppInner` state, `renderRow` ~line 681)

**Interfaces:**
- Consumes: `RenderRow.runs[].style.caret` from the emulator.
- Produces: caret alternates visible/hidden at ~530ms. Rows WITHOUT a caret must not re-render on blink ticks (custom memo comparator) — TUI repaint performance is the reason `TermRow` is memoized at all.

- [ ] **Step 1: Implement**

`runToStyle` takes a blink flag; the caret styling only applies when on:

```ts
function runToStyle(s: CellStyle, caretOn = true): TextStyle {
  const style: TextStyle = {};
  if (s.fg) style.color = s.fg;
  if (s.bg) style.backgroundColor = s.bg;
  if (s.bold) style.fontWeight = 'bold';
  if (s.dim) style.opacity = 0.55;
  if (s.italic) style.fontStyle = 'italic';
  if (s.underline && s.strike) style.textDecorationLine = 'underline line-through';
  else if (s.underline) style.textDecorationLine = 'underline';
  else if (s.strike) style.textDecorationLine = 'line-through';
  if (s.caret && caretOn) {
    // Block caret: accent background, dark glyph for contrast.
    style.backgroundColor = '#818cf8';
    style.color = '#0b0f19';
  }
  return style;
}
```

`TermRow` gains a `blinkOn` prop and a comparator that ignores blink for caret-less rows:

```tsx
const rowHasCaret = (row: RenderRow) => row.runs.some((r) => r.style.caret);

const TermRow = React.memo(
  function TermRow({
    row,
    fontSize,
    lineHeight,
    width,
    blinkOn,
  }: {
    row: RenderRow;
    fontSize: number;
    lineHeight: number;
    width: number;
    blinkOn: boolean;
  }) {
    return (
      <View style={{ height: lineHeight, width, overflow: 'hidden' }}>
        <Text style={[styles.termLine, { fontSize, lineHeight, width }]} numberOfLines={1}>
          {row.runs.map((run, i) => (
            <Text key={i} style={runToStyle(run.style, blinkOn)}>
              {run.text}
            </Text>
          ))}
        </Text>
      </View>
    );
  },
  (prev, next) =>
    prev.row === next.row &&
    prev.fontSize === next.fontSize &&
    prev.lineHeight === next.lineHeight &&
    prev.width === next.width &&
    // Blink only invalidates the row that actually contains the caret.
    (prev.blinkOn === next.blinkOn || !rowHasCaret(next.row)),
);
```

In `AppInner`, add state + timer (next to the other effects):

```ts
  const [blinkOn, setBlinkOn] = useState(true);
  useEffect(() => {
    const iv = setInterval(() => setBlinkOn((v) => !v), 530);
    return () => clearInterval(iv);
  }, []);
```

Thread it through `renderRow`:

```ts
  const renderRow = useCallback(
    ({ item }: { item: RenderRow }) => (
      <TermRow
        row={item}
        fontSize={fontSize}
        lineHeight={lineHeight}
        width={gridWidth}
        blinkOn={blinkOn}
      />
    ),
    [fontSize, lineHeight, gridWidth, blinkOn],
  );
```

- [ ] **Step 2: Verify**

`cd apps/mobile && npx tsc --noEmit` — clean.
Manual: idle shell prompt — caret blinks ~1Hz. Run a TUI that hides the cursor (`?25l`, e.g. Claude Code spinner) — no caret, no blink flicker. While `yes` streams, output stays smooth (blink must not re-render every row — spot-check with React DevTools profiler if in doubt).

- [ ] **Step 3: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/App.tsx
git commit -m "feat(mobile): blinking block cursor (caret-row-only re-render)"
```

---

### Task 13: Client — search memoization, paste error feedback, dead-code deletion

**Files:**
- Modify: `apps/mobile/App.tsx` (`getSearchText` ~line 534, selection modal ~line 1037, `handlePaste` ~line 566, dead history code at lines ~35/165-166/455-469/603-622)

**Interfaces:**
- Consumes: `screen` state, `searchQuery`, `Clipboard`.
- Produces: `searchText: string` memo replacing `getSearchText()` calls in the selection modal; paste alerts on clipboard failure; `commandHistory`/`historyIndex`/`navigateHistory`/`KEY_HISTORY` deleted (referenced nowhere in the UI).

- [ ] **Step 1: Memoize the search text**

Add `useMemo` to the React import if absent, then replace the `getSearchText` function with:

```ts
  // Transcript filtered to lines matching the query — memoized: the previous
  // version re-split the whole scrollback on every keystroke and every render.
  const searchText = useMemo(() => {
    const full = getFullText();
    const q = searchQuery.trim().toLowerCase();
    if (!q) return full;
    return full
      .split('\n')
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n');
  }, [screen, searchQuery]);
```

In the selection-view modal, replace all three `getSearchText()` calls:

```tsx
              {selectionViewOpen && (
                <TextInput
                  style={styles.selectionViewText}
                  value={searchText}
                  editable={false}
                  multiline
                  scrollEnabled
                  selection={{ start: searchText.length, end: searchText.length }}
                />
              )}
```

- [ ] **Step 2: Paste error feedback**

Replace `handlePaste`:

```ts
  const handlePaste = async () => {
    let text = '';
    try {
      text = await Clipboard.getStringAsync();
    } catch {
      Alert.alert('Paste failed', 'Could not read the clipboard.');
      return;
    }
    if (!text) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const e = cache.get(activeIdRef.current);
    sendInput(e?.term.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text);
  };
```

- [ ] **Step 3: Delete dead history code**

Remove (nothing in the JSX references any of it — arrows send escape sequences straight to the shell, which owns history):
- `const KEY_HISTORY = 'tether_history';` (~line 36)
- `const [commandHistory, setCommandHistory] = useState<string[]>([]);` and `const [historyIndex, setHistoryIndex] = useState(-1);` (~lines 165-166)
- In `loadConfig`: the `AsyncStorage.getItem(KEY_HISTORY)` entry from the `Promise.all` array, the `savedHistory` destructuring slot, and `if (savedHistory) setCommandHistory(JSON.parse(savedHistory));`
- The entire `navigateHistory` function (~lines 603-622)

- [ ] **Step 4: Verify**

`cd apps/mobile && npx tsc --noEmit` — clean (this catches any missed reference to the deleted symbols). `bun lint` — clean.
Manual: open Search from the overflow menu, type — filtering stays fluid; paste with clipboard content — works as before.

- [ ] **Step 5: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/App.tsx
git commit -m "fix(mobile): memoize scrollback search; paste failure alert; drop dead history code"
```

---

## Final verification (after all tasks)

```bash
cd /home/samuelloranger/sites/tether
bun --cwd apps/server typecheck
cd apps/server && TETHER_DB_PATH=/tmp/tether-final-$$.db bun run src/server/db.test.ts && TETHER_DB_PATH=/tmp/tether-final-$$.db bun run src/server/pty.dims.test.ts
cd ../mobile && bun run src/terminal.test.ts && npx tsc --noEmit
cd .. && bun lint
```

All green + a manual end-to-end pass on device: connect, run `htop` (box borders render), type emoji (aligned), rotate + toggle keyboard (prompt stays visible), scroll up during `yes` output (no yank), kill server mid-session and restart it (session shows stopped, reconnect works).

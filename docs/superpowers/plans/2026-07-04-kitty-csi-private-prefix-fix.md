# Kitty Keyboard Protocol CSI Misparse Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the mobile terminal emulator from misinterpreting kitty-keyboard-protocol and other private-prefixed CSI sequences, which today teleports the cursor when Claude Code exits (double Ctrl+C) and leaves the screen garbled until the user types `clear`.

**Architecture:** `TerminalEmulator.dispatchCsi()` in `apps/mobile/src/terminal.ts` only recognizes `?` as a private parameter prefix. Claude Code emits `ESC[<u` (kitty keyboard pop) on exit and `ESC[>4m` (XTMODKEYS reset); the emulator misparses these as ANSI restore-cursor (`CSI u`) and SGR (`CSI m`). The fix generalizes prefix detection to all private prefix bytes (`?`, `<`, `=`, `>`) and gates the `u`, `s`, `m`, and `c` handlers on the prefix. Bundled same-class hardening: ignore CSI sequences with intermediate bytes (today `CSI SP A` scroll-right misfires as cursor-up), stop answering tertiary DA (`CSI = c`) with the primary DA reply, and implement `ESC D`/`ESC E` (IND/NEL) instead of dropping them. Pure logic change in one dependency-free TS file, covered by a new `bun test` suite.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome formatting. `apps/mobile/src/terminal.ts` has zero imports and runs fine under plain Bun (verified — the debugging repro harness imported it directly).

## Global Constraints

- Repo has **no test runner configured**; use Bun's built-in `bun test`, invoked with an explicit path (`bun test apps/mobile/src/terminal.test.ts`) so it does not require any package.json changes.
- Biome formatting: 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` (repo root) before committing — note it only covers `apps/server`, so also run `bunx biome check --write apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts` for the mobile files.
- Do not change the public API of `TerminalEmulator` (App.tsx consumes `write`, `getSnapshot`, `reset`, `resize`, `onReply`, `mouseOn`, `cursorVisible`, `bracketedPaste`).
- No Co-Authored-By trailers in commits.

## Verified root cause (evidence)

Reproduced by driving a real tether session over WebSocket: run `claude`, send `\x03` twice, feed every output chunk through `TerminalEmulator`. Claude Code's exit byte stream is:

```
ESC[?1006l ESC[?1003l ESC[?1002l ESC[?1000l   ; mouse modes off (handled OK)
ESC[2D ESC[3B                                  ; cursor below the input box (handled OK)
ESC(B  ESC[>4m  ESC[<u                         ; charset, XTMODKEYS reset, kitty-keyboard POP
ESC[?1004l ESC[?2031l ESC[?2004l ESC[?25h      ; focus/color/paste modes, show cursor
ESC7 ESC[r ESC8                                ; save cursor, reset scroll region, restore
```

`ESC[<u` hits `case 'u'` in `dispatchCsi` → `cx/cy = savedCx/savedCy`. Those were never saved during the session, so the cursor jumps to (0,0). The shell prompt then paints on screen row 0 (mid-transcript), and Claude's input box / "Press Ctrl-C again to exit" rows are never overwritten. Replaying the identical capture with `ESC[<u` stripped renders the prompt on the row directly below Claude's last frame — identical to desktop terminal behavior.

Secondary (same class): `ESC[>4m` reaches `applySgr()`, where `parseInt('>4')` → NaN → param 0 → full SGR reset of the live pen. Harmless in the capture but wrong. `ESC[>0q` (XTVERSION) already falls through harmlessly — no change needed.

---

### Task 1: Failing tests for private-prefixed CSI sequences

**Files:**
- Create: `apps/mobile/src/terminal.test.ts`

**Interfaces:**
- Consumes: `TerminalEmulator` from `./terminal` — `constructor(cols, rows)`, `write(data: string)`, `getSnapshot(): RenderRow[]` where each row has `runs: { text: string; bold?: boolean; ... }[]`.
- Produces: test file used by Task 2; helper `rows(emu)` returning `string[]` of plain-text rows.

Cursor position is private, so tests observe it indirectly: write a probe character after the sequence under test and assert which row/column it lands on.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from 'bun:test';
import { TerminalEmulator } from './terminal';

function rows(emu: TerminalEmulator): string[] {
  return emu.getSnapshot().map((r) => r.runs.map((run) => run.text).join(''));
}

describe('private-prefixed CSI sequences (kitty keyboard protocol, XTMODKEYS)', () => {
  test('plain CSI s / CSI u still save and restore the cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[2;3H\x1b[s'); // move to row 2 col 3, save
    emu.write('\x1b[5;1H'); // wander away
    emu.write('\x1b[uX'); // restore, probe
    expect(rows(emu)[1]).toContain('X'); // row 2 (0-indexed 1)
  });

  test('CSI < u (kitty pop) does NOT restore the cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[4;1H'); // cursor on row 4
    emu.write('\x1b[<u'); // kitty keyboard pop — must be a no-op
    emu.write('X');
    expect(rows(emu)[3]).toContain('X'); // still row 4
    expect(rows(emu)[0]).not.toContain('X'); // did NOT jump to never-saved (0,0)
  });

  test('CSI > 1 u (kitty push) does NOT restore the cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[4;1H\x1b[>1uX');
    expect(rows(emu)[3]).toContain('X');
  });

  test('CSI ? u (kitty query) does NOT restore or save the cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[4;1H\x1b[?uX');
    expect(rows(emu)[3]).toContain('X');
  });

  test('CSI ? s (XTSAVE) does NOT overwrite the saved cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[2;3H\x1b[s'); // save at row 2
    emu.write('\x1b[5;1H\x1b[?1s'); // XTSAVE private mode — must not re-save here
    emu.write('\x1b[uX');
    expect(rows(emu)[1]).toContain('X'); // restored to row 2, not row 5
  });

  test('CSI > 4 m (XTMODKEYS) does NOT reset SGR attributes', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[1m'); // bold on
    emu.write('\x1b[>4m'); // XTMODKEYS — must not touch the pen
    emu.write('X');
    const runs = emu.getSnapshot()[0].runs;
    const xRun = runs.find((r) => r.text.includes('X'));
    expect(xRun?.bold).toBe(true);
  });

  test('CSI with intermediate bytes is ignored, not misdispatched', () => {
    const emu = new TerminalEmulator(20, 5);
    // CSI 2 SP A is xterm scroll-right (SR); without the guard it misfires as
    // cursor-up-2. Cursor must stay on row 4.
    emu.write('\x1b[4;1H\x1b[2 AX');
    expect(rows(emu)[3]).toContain('X');
  });

  test('DECSCUSR (CSI Ps SP q) is ignored', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[4;1H\x1b[6 qX'); // vim sets cursor style with this
    expect(rows(emu)[3]).toContain('X');
  });

  test('tertiary DA (CSI = c) gets no reply; primary and secondary still do', () => {
    const emu = new TerminalEmulator(20, 5);
    const replies: string[] = [];
    emu.onReply = (d) => replies.push(d);
    emu.write('\x1b[=c');
    expect(replies).toEqual([]); // must NOT answer with the primary DA string
    emu.write('\x1b[c');
    expect(replies).toEqual(['\x1b[?1;2c']);
    emu.write('\x1b[>c');
    expect(replies).toEqual(['\x1b[?1;2c', '\x1b[>0;0;0c']);
  });

  test('ESC D (IND) scrolls like line feed; ESC E (NEL) also returns to col 0', () => {
    const emu = new TerminalEmulator(20, 3);
    emu.write('one\r\ntwo\r\nthree'); // cursor on bottom row after "three"
    emu.write('\x1bD'); // IND at bottom -> scroll up one line
    emu.write('X');
    const r = rows(emu);
    expect(r[r.length - 1]).toContain('X'); // new bottom line
    expect(r.join('\n')).toContain('one'); // "one" pushed to scrollback, still present

    const emu2 = new TerminalEmulator(20, 3);
    emu2.write('abc\x1bEX'); // NEL: next line, column 0
    expect(rows(emu2)[1]?.startsWith('X')).toBe(true);
  });

  test('claude exit tail: prompt lands below the last frame, not mid-screen', () => {
    const emu = new TerminalEmulator(40, 10);
    // Minimal reconstruction of the observed exit stream: UI box on rows 7-9,
    // cursor parked below it, then the real exit sequence claude emits.
    emu.write('\x1b[7;1H> input box\r\n exit hint\r\n');
    emu.write('\x1b(B\x1b[>4m\x1b[<u\x1b[?2004l\x1b[?25h\x1b7\x1b[r\x1b8');
    emu.write('user@host ~> ');
    expect(rows(emu)[9]).toContain('user@host'); // bottom row, below the box
    expect(rows(emu)[0]).not.toContain('user@host');
  });
});
```

- [ ] **Step 2: Run tests, verify the new-behavior ones fail**

Run: `cd /home/samuelloranger/sites/tether && bun test apps/mobile/src/terminal.test.ts`
Expected: `plain CSI s / CSI u` and `DECSCUSR` PASS (they guard existing behavior); FAIL: `CSI < u`, `CSI > 1 u`, `CSI ? u`, `CSI ? s`, `CSI > 4 m`, `CSI with intermediate bytes`, `tertiary DA`, `ESC D / ESC E` (the NEL half), and `claude exit tail`.

- [ ] **Step 3: Commit the failing tests**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/src/terminal.test.ts
git commit -m "test(mobile): cover private-prefixed CSI sequences in emulator"
```

(Committing red tests is fine here — next task turns them green in the same push.)

---

### Task 2: Harden CSI/ESC dispatch (private prefixes, intermediates, IND/NEL)

**Files:**
- Modify: `apps/mobile/src/terminal.ts:287-457` (`esc()`, `nums()` and `dispatchCsi()`)
- Test: `apps/mobile/src/terminal.test.ts` (from Task 1)

**Interfaces:**
- Consumes: `this.params` / `this.intermediate` (raw CSI parameter and intermediate strings), existing handlers.
- Produces: no API change; `dispatchCsi` ignores kitty/XTMODKEYS/XTSAVE and intermediate-byte sequences, DA replies are prefix-correct, `esc()` gains IND/NEL.

- [ ] **Step 1: Generalize prefix detection in `dispatchCsi` and guard intermediates**

Replace the first line of `dispatchCsi` (currently `const priv = this.params.startsWith('?');` at `terminal.ts:356`):

```typescript
  private dispatchCsi(final: string) {
    // Sequences with intermediate bytes (CSI Ps SP q cursor style, CSI Ps SP A
    // scroll-right, CSI ! p soft reset, ...) share final bytes with plain ANSI
    // actions but mean something else entirely. None are implemented — ignore
    // them wholesale rather than misdispatch (SP A would run as cursor-up).
    if (this.intermediate) return;
    // Private parameter prefix byte (0x3c-0x3f): '?' DEC modes, and '<' '=' '>'
    // used by the kitty keyboard protocol / XTMODKEYS / XTVERSION. A prefixed
    // sequence is never the plain ANSI action with the same final byte.
    const prefix = /^[<=>?]/.test(this.params) ? this.params[0] : '';
    const priv = prefix === '?';
```

- [ ] **Step 2: Strip all prefix bytes in `nums()`**

Replace the two first lines of `nums()` (`terminal.ts:346-347`):

```typescript
  private nums(def: number): number[] {
    const raw = /^[<=>?]/.test(this.params) ? this.params.slice(1) : this.params;
```

- [ ] **Step 3: Gate the `s`, `u`, `m`, and `c` cases**

In the `dispatchCsi` switch, change these four cases (leave everything else untouched — `h`/`l` are already gated on `priv`):

```typescript
      case 's':
        // Plain CSI s = save cursor. CSI ? Ps s is XTSAVE (private mode save).
        if (!prefix) {
          this.savedCx = this.cx;
          this.savedCy = this.cy;
        }
        break;
      case 'u':
        // Plain CSI u = restore cursor. CSI < u / CSI > Ps u / CSI = Ps u /
        // CSI ? u are the kitty keyboard protocol (pop/push/set/query) —
        // claude emits CSI < u on exit; treating it as restore-cursor
        // teleported the cursor into the old transcript.
        if (!prefix) {
          this.cx = this.savedCx;
          this.cy = this.savedCy;
        }
        break;
      case 'm':
        // CSI > Ps m is XTMODKEYS, CSI ? Ps m is XTQMODKEYS — not SGR.
        if (!prefix) this.applySgr();
        break;
      case 'c':
        // DA — device attributes. Plain = primary, '>' = secondary. '=' is
        // tertiary DA — answering it with the primary string confuses the
        // querying app, so stay silent (like the ignored '?' form).
        if (prefix === '>') this.onReply?.('\x1b[>0;0;0c');
        else if (!prefix) this.onReply?.('\x1b[?1;2c');
        break;
```

- [ ] **Step 4: Implement ESC D (IND) and ESC E (NEL)**

In `esc()` (`terminal.ts:287-327`), add two cases next to `case 'M':` and update the trailing comment:

```typescript
      case 'D':
        this.lineFeed(); // IND — index (line feed without carriage return)
        break;
      case 'E':
        this.lineFeed(); // NEL — next line
        this.cx = 0;
        break;
      case 'M':
        this.reverseIndex();
        break;
      case 'c':
        this.reset();
        return;
      // '=', '>', etc. — ignore
```

- [ ] **Step 5: Run the tests, verify all pass**

Run: `cd /home/samuelloranger/sites/tether && bun test apps/mobile/src/terminal.test.ts`
Expected: 11 pass, 0 fail.

- [ ] **Step 6: Typecheck + format**

```bash
cd /home/samuelloranger/sites/tether
bunx tsc --noEmit -p apps/mobile 2>/dev/null || true   # Expo project; skip if no tsconfig typecheck script
bunx biome check --write apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
bun lint
```

Expected: Biome clean; `bun lint` passes.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.test.ts
git commit -m "fix(mobile): harden CSI dispatch against lookalike sequences

Claude Code emits ESC[<u (kitty keyboard pop) on exit; the emulator
parsed any CSI final 'u' as restore-cursor and teleported the cursor to
a never-saved position, leaving the old UI on screen until a manual
clear. Same class of bug fixed alongside:
- gate s/u/m/c on private prefix bytes (<=>?), strip them in nums()
- ignore CSI sequences carrying intermediate bytes (SP A scroll-right
  would have run as cursor-up, etc.)
- stop answering tertiary DA (ESC[=c) with the primary DA reply
- implement ESC D (IND) and ESC E (NEL) instead of dropping them"
```

---

### Task 3: End-to-end verification against a live claude exit

**Files:**
- None modified (verification only). Repro harness already exists at `/tmp/claude-1000/-home-samuelloranger-sites-tether/83b13a81-8375-41b6-8286-86554ef331b8/scratchpad/repro-ctrlc.ts` (recreate from this plan's appendix if the scratchpad is gone).

- [ ] **Step 1: Re-run the live repro**

Run: `bun /tmp/claude-1000/-home-samuelloranger-sites-tether/83b13a81-8375-41b6-8286-86554ef331b8/scratchpad/repro-ctrlc.ts` (tether server must be up on :8085; the script creates its own throwaway session and kills it afterwards).

Expected: in the printed final grid, the `user@host ~>` fish prompt appears on the row **directly below** Claude's last frame ("Press Ctrl-C again to exit"), not mid-transcript. The last frame itself remains visible above the prompt — that matches desktop terminal behavior and is correct.

- [ ] **Step 2: Rebuild the mobile app and verify on device**

```bash
cd /home/samuelloranger/sites/tether/apps/mobile && npx expo run:ios --device
```

On the phone: open a session, run `claude`, Ctrl+C twice. Expected: shell prompt appears below Claude's output; typing works at the correct position; no `clear` needed.

- [ ] **Step 3: Ship**

Version bump + release only if the user wants it in the AltStore build (v1.0.4); otherwise leave on main.

---

## Appendix: repro harness

Drives a real tether session over WS, feeds output through the real emulator, prints the final grid. Recreate at any path and run with `bun`:

```typescript
import { TerminalEmulator } from '/home/samuelloranger/sites/tether/apps/mobile/src/terminal.ts';
const SESSION = `debug-ctrlc-${process.pid}`;
const emu = new TerminalEmulator(60, 30);
let raw = '';
const ws = new WebSocket(`ws://localhost:8085/api/ws?sessionId=${SESSION}&sinceId=0&cols=60&rows=30`);
const send = (text: string) => ws.send(JSON.stringify({ type: 'input', text }));
emu.onReply = send;
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data as string);
  if (msg.type === 'output') {
    raw += msg.chunk;
    emu.write(msg.chunk);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
ws.onopen = async () => {
  await sleep(3000);
  send('claude\r');
  await sleep(20000);
  send('\x03');
  await sleep(400);
  send('\x03');
  await sleep(6000);
  const grid = emu.getSnapshot().map((r, i) => `${i}|${r.runs.map((x) => x.text).join('')}`);
  console.log(grid.slice(-15).join('\n'));
  await fetch('http://localhost:8085/api/sessions/kill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION }),
  });
  process.exit(0);
};
```

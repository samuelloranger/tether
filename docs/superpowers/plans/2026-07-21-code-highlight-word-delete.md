# Code Highlighting Completion + Word Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prism highlighting in the one code view still missing it (SideBySideDiff), hold-backspace word deletion on iOS/Android, and Alt/Ctrl+Backspace word deletion on desktop.

**Architecture:** Highlighting infra already exists (`CodeHighlight.tsx` + `codeLanguage.ts`, used by `FileViewer` and `DiffLines`) — only `SideBySideDiff` renders plain text; extract the shared per-line tokenizer and wire it in. Mobile word delete is a pure streak tracker in `input.ts` consulted by `handleChangeText`. Desktop word delete is two new cases in `keyToBytes`.

**Tech Stack:** Bun workspaces, Expo RN (apps/mobile), prism-react-renderer 2.4.1 (already a dependency), `bun test`.

## Global Constraints

- Formatting: Biome — 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` from repo root before each commit.
- Word-delete byte for hold-backspace: `\x17` (Ctrl+W, tty werase) — per spec.
- Desktop Alt+Backspace byte: `\x1b\x7f` (readline backward-kill-word); Ctrl+Backspace: `\x17`.
- Streak parameters: gap < 150 ms, threshold 15 consecutive single-deletes.
- All work in `apps/mobile`; run tests from `apps/mobile` with `bun test <file>`.
- Existing `input.test.ts` uses a script style (`eq()` helper, top-level blocks); follow it there. `desktopKeys.test.ts` uses `describe/test/expect`; follow that there.

---

### Task 1: Per-line tokenizer helper + SideBySideDiff highlighting

**Files:**
- Modify: `apps/mobile/src/CodeHighlight.tsx` (add exported helper)
- Modify: `apps/mobile/src/DiffLines.tsx` (use helper — removes duplicated tokenize expression)
- Modify: `apps/mobile/src/SideBySideDiff.tsx` (add `path` prop + highlighted cell content)
- Modify: `apps/mobile/src/DiffView.tsx:124` (pass `path` to `SideBySideDiff`)
- Test: `apps/mobile/src/codeHighlight.test.ts`

**Interfaces:**
- Produces: `tokenizeLine(content: string, grammar: Prism.Grammar | undefined): Token[] | null` exported from `CodeHighlight.tsx` (returns `null` when grammar is undefined; one line's normalized tokens otherwise). `SideBySideDiff` gains required prop `path: string`.
- Consumes: existing `languageForPath(path: string): string | null` from `codeLanguage.ts`, `colorForTokenTypes(types, colors)` from `CodeHighlight.tsx`.

- [ ] **Step 1: Write the failing test** — append to `apps/mobile/src/codeHighlight.test.ts` (file uses `bun:test` `test/expect`, flat, no describe):

```ts
test('tokenizeLine returns null without a grammar', () => {
  expect(tokenizeLine('const x = 1;', undefined)).toBeNull();
});

test('tokenizeLine tokenizes one line with a grammar', () => {
  const grammar = Prism.languages.typescript;
  const tokens = tokenizeLine('const x = 1;', grammar);
  expect(tokens).not.toBeNull();
  expect(tokens!.map((t) => t.content).join('')).toBe('const x = 1;');
  expect(tokens!.some((t) => t.types.includes('keyword'))).toBe(true);
});
```

Imports at top of the test file: `import { Prism } from 'prism-react-renderer';` and `import { tokenizeLine } from './CodeHighlight';`.

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/mobile`): `bun test src/codeHighlight.test.ts`
Expected: FAIL — `tokenizeLine` is not exported.

- [ ] **Step 3: Implement `tokenizeLine`** in `CodeHighlight.tsx`:

```ts
import { Highlight, normalizeTokens, Prism, type PrismTheme } from 'prism-react-renderer';

// One diff/code line tokenized independently, so surrounding lines (hunk
// gaps, +/- markers) never corrupt the grammar. Null when no grammar.
export function tokenizeLine(
  content: string,
  grammar: Prism.Grammar | undefined,
): ReturnType<typeof normalizeTokens>[number] | null {
  if (!grammar) return null;
  return normalizeTokens(Prism.tokenize(content, grammar))[0] ?? [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/codeHighlight.test.ts`
Expected: PASS.

- [ ] **Step 5: Use the helper in `DiffLines.tsx`** — replace

```ts
        const tokens = grammar
          ? (normalizeTokens(Prism.tokenize(line.content, grammar))[0] ?? [])
          : null;
```

with

```ts
        const tokens = tokenizeLine(line.content, grammar);
```

Add `tokenizeLine` to the `./CodeHighlight` import; drop the now-unused `normalizeTokens, Prism` import from `prism-react-renderer` (keep `Prism` only if still referenced for `Prism.languages[language]` — it is; keep it, drop `normalizeTokens`).

- [ ] **Step 6: Highlight `SideBySideDiff.tsx`.** Add `path` prop, grammar lookup, and token rendering in `cell`:

```tsx
import { Prism } from 'prism-react-renderer';
import { StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { colorForTokenTypes, tokenizeLine } from './CodeHighlight';
import { languageForPath } from './codeLanguage';
import { type DiffLine, pairDiffRows, parseDiffLines } from './diffModel';
```

```tsx
export function SideBySideDiff({ diffText, path }: { diffText: string; path: string }) {
  const { theme } = useAppTheme();
  const language = languageForPath(path);
  const grammar = language ? Prism.languages[language] : undefined;
```

In `cell`, replace the content `<Text>`:

```tsx
    const tokens = line ? tokenizeLine(line.content, grammar) : null;
    return (
      <View style={[styles.cell, bg ? { backgroundColor: bg } : null]}>
        <Text style={[styles.gutterNum, TEXT_METRICS, { color: theme.colors.textFaint }]}>
          {lineNumber ?? ''}
        </Text>
        <Text selectable style={[styles.content, TEXT_METRICS, { color: theme.terminal.fg }]}>
          {tokens
            ? tokens.map((token, tokenIndex) => (
                <Text
                  key={tokenIndex}
                  style={{ color: colorForTokenTypes(token.types, theme.colors) }}
                >
                  {token.content}
                </Text>
              ))
            : (line?.content ?? '')}
        </Text>
      </View>
    );
```

- [ ] **Step 7: Pass `path` at the call site.** `DiffView.tsx` line ~124, inside `renderDiffBody(text, truncated, path, hunks)`:

```tsx
        <SideBySideDiff diffText={displayDiff(text, truncated)} path={path} />
```

- [ ] **Step 8: Verify** — run full mobile tests + lint:

Run (from `apps/mobile`): `bun test`  → Expected: all pass.
Run (from repo root): `bun format && bun lint` → Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src/CodeHighlight.tsx apps/mobile/src/DiffLines.tsx apps/mobile/src/SideBySideDiff.tsx apps/mobile/src/DiffView.tsx apps/mobile/src/codeHighlight.test.ts
git commit -m "feat(mobile): syntax highlighting in side-by-side diff"
```

---

### Task 2: Backspace streak tracker (mobile word delete)

**Files:**
- Modify: `apps/mobile/src/input.ts`
- Modify: `apps/mobile/src/useTetherApp.tsx` (`handleChangeText`, `resetField`, `handleSend`)
- Test: `apps/mobile/src/input.test.ts`

**Interfaces:**
- Produces (from `input.ts`):

```ts
export interface BackspaceStreak { count: number; lastAt: number }
export const EMPTY_STREAK: BackspaceStreak; // { count: 0, lastAt: 0 }
export const STREAK_GAP_MS = 150;
export const STREAK_THRESHOLD = 15;
// Feed every outgoing input delta. Returns the new streak state and the
// bytes to actually send (rewrites '\x7f' to '\x17' past the threshold).
export function applyBackspaceStreak(
  streak: BackspaceStreak,
  bytes: string,
  now: number,
): { streak: BackspaceStreak; bytes: string };
```

- Consumes: `applyFieldChange` output (`bytes`), wired in `handleChangeText`.

- [ ] **Step 1: Write failing tests** — append to `apps/mobile/src/input.test.ts` in its existing `eq()` block style (extend the top import):

```ts
import {
  applyBackspaceStreak,
  applyFieldChange,
  computeInputDelta,
  EMPTY_STREAK,
  SENT,
  STREAK_THRESHOLD,
} from './input';

// N. Below threshold, backspaces pass through unchanged
{
  let s = EMPTY_STREAK;
  for (let i = 0; i < STREAK_THRESHOLD; i++) {
    const r = applyBackspaceStreak(s, '\x7f', 1000 + i * 100);
    eq(r.bytes, '\x7f', `streak pass-through at ${i}`);
    s = r.streak;
  }
}

// N+1. Past threshold, backspace upgrades to Ctrl+W (word delete)
{
  let last = { streak: EMPTY_STREAK, bytes: '' };
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    last = applyBackspaceStreak(last.streak, '\x7f', 1000 + i * 100);
  }
  eq(last.bytes, '\x17', 'streak upgrades to word delete past threshold');
}

// N+2. A gap >= 150ms resets the streak
{
  let s = EMPTY_STREAK;
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    ({ streak: s } = applyBackspaceStreak(s, '\x7f', 1000 + i * 100));
  }
  const r = applyBackspaceStreak(s, '\x7f', 100000);
  eq(r.bytes, '\x7f', 'gap resets streak to char delete');
}

// N+3. Any non-backspace bytes reset the streak
{
  let s = EMPTY_STREAK;
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    ({ streak: s } = applyBackspaceStreak(s, '\x7f', 1000 + i * 100));
  }
  const typed = applyBackspaceStreak(s, 'a', 2600);
  eq(typed.bytes, 'a', 'typing passes through');
  const after = applyBackspaceStreak(typed.streak, '\x7f', 2700);
  eq(after.bytes, '\x7f', 'typing reset the streak');
}
```

(Number the comment blocks to continue the file's existing sequence.)

- [ ] **Step 2: Run to verify failure**

Run (from `apps/mobile`): `bun test src/input.test.ts`
Expected: FAIL — `applyBackspaceStreak` not exported.

- [ ] **Step 3: Implement in `input.ts`:**

```ts
// Hold-backspace word deletion: the capture field is pinned to a sentinel, so
// when iOS/Android keyboards accelerate into word-delete mode the field still
// only ever yields single-character deletes. The PTY owns the line state, so
// the client can't know word boundaries — instead, detect the streak: after
// STREAK_THRESHOLD rapid consecutive single deletes, upgrade each further
// delete to Ctrl+W (tty werase) so the shell erases whole words.
export interface BackspaceStreak {
  count: number;
  lastAt: number;
}

export const EMPTY_STREAK: BackspaceStreak = { count: 0, lastAt: 0 };
export const STREAK_GAP_MS = 150;
export const STREAK_THRESHOLD = 15;

export function applyBackspaceStreak(
  streak: BackspaceStreak,
  bytes: string,
  now: number,
): { streak: BackspaceStreak; bytes: string } {
  if (bytes !== '\x7f') return { streak: EMPTY_STREAK, bytes };
  const count = now - streak.lastAt < STREAK_GAP_MS ? streak.count + 1 : 1;
  const next = { count, lastAt: now };
  return { streak: next, bytes: count > STREAK_THRESHOLD ? '\x17' : '\x7f' };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/input.test.ts` → Expected: PASS.

- [ ] **Step 5: Wire into `useTetherApp.tsx`.** Add a ref next to `prevValueRef` (same component scope):

```ts
const backspaceStreakRef = useRef(EMPTY_STREAK);
```

Extend the `./input` import: `import { applyBackspaceStreak, applyFieldChange, EMPTY_STREAK, SENT } from './input';`

In `handleChangeText`, replace the send block:

```ts
    const { bytes, value } = applyFieldChange(prevValueRef.current, next);
    if (bytes) {
      const tracked = applyBackspaceStreak(backspaceStreakRef.current, bytes, Date.now());
      backspaceStreakRef.current = tracked.streak;
      sendInput(tracked.bytes);
      autoScroll.current = true;
    }
```

In `resetField`, add `backspaceStreakRef.current = EMPTY_STREAK;`. In `handleSend` (sends `\r` then `resetField()`) the reset already covers it.

- [ ] **Step 6: Full verify**

Run (from `apps/mobile`): `bun test` → all pass. From repo root: `bun format && bun lint` → clean. Typecheck if configured for mobile: `bunx tsc --noEmit -p apps/mobile` (skip if no tsconfig checks).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/input.ts apps/mobile/src/input.test.ts apps/mobile/src/useTetherApp.tsx
git commit -m "feat(mobile): hold-backspace upgrades to word deletion"
```

---

### Task 3: Desktop Alt+Backspace / Ctrl+Backspace

**Files:**
- Modify: `apps/mobile/src/desktopKeys.ts` (the `if (key === 'Backspace')` case, ~line 101)
- Test: `apps/mobile/src/desktopKeys.test.ts`

**Interfaces:**
- Consumes/produces: existing `keyToBytes(e: KeyLike, appCursor?, isMac?): string | null`; no signature change.

- [ ] **Step 1: Write failing tests** — in `desktopKeys.test.ts`, inside the named-keys describe (uses the file's `k()` helper):

```ts
  test('Alt+Backspace deletes the previous word (readline ESC DEL)', () => {
    expect(keyToBytes(k('Backspace', { altKey: true }))).toBe('\x1b\x7f');
  });
  test('Ctrl+Backspace deletes the previous word (werase)', () => {
    expect(keyToBytes(k('Backspace', { ctrlKey: true }))).toBe('\x17');
  });
  test('plain Backspace still sends DEL', () => {
    expect(keyToBytes(k('Backspace'))).toBe('\x7f');
  });
```

- [ ] **Step 2: Run to verify failure**

Run (from `apps/mobile`): `bun test src/desktopKeys.test.ts`
Expected: the two new tests FAIL (`'\x7f'` returned for both combos — note the Ctrl+symbol block at ~line 93 does not match 'Backspace', so it falls through to line 101).

- [ ] **Step 3: Implement** — replace `if (key === 'Backspace') return '\x7f';` with:

```ts
  // Word deletion: Alt+Backspace sends readline backward-kill-word (ESC DEL,
  // same Meta- convention as the Alt+Arrow word-motion below); Ctrl+Backspace
  // sends werase (Ctrl+W) for the Windows/Linux habit.
  if (key === 'Backspace') {
    if (e.altKey) return '\x1b\x7f';
    if (e.ctrlKey) return '\x17';
    return '\x7f';
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/desktopKeys.test.ts` → PASS.

- [ ] **Step 5: Full verify + commit**

Run (from `apps/mobile`): `bun test`; from root: `bun format && bun lint`.

```bash
git add apps/mobile/src/desktopKeys.ts apps/mobile/src/desktopKeys.test.ts
git commit -m "feat(desktop): Alt/Ctrl+Backspace word deletion"
```

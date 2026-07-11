# Diff-based Terminal Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable voice dictation, swipe-typing, and autocomplete on the mobile terminal by sending the text *delta* from `onChangeText` to the PTY instead of discarding it.

**Architecture:** Extract the field-mutation → PTY-bytes logic into a pure, unit-tested function (`computeInputDelta`) in a new `src/input.ts`. Wire it into the hidden capture `TextInput` in `App.tsx`: `onChangeText` computes the delta and sends it; `onKeyPress` is narrowed to Ctrl-combo transforms only (with a skip flag to avoid double-send); `handleSend` collapses the field back to the sentinel.

**Tech Stack:** Expo 57 / React Native 0.86 / React 19, TypeScript, `bun test`.

## Global Constraints

- Mobile-only change: touch `apps/mobile/App.tsx` and add `apps/mobile/src/input.ts` + its test. Do not touch server/PTY code.
- Zero-width sentinel value is U+200B. Define it once in `src/input.ts` as `SENT` and import it into `App.tsx` (remove the local `const SENT` at `App.tsx:43`).
- Formatting: Biome is server-only; mobile uses `tsc --noEmit` (`bun run lint` from `apps/mobile`). Match existing 2-space / single-quote / semicolon style in the files.
- Expo rule (`apps/mobile/AGENTS.md`): consult https://docs.expo.dev/versions/v57.0.0/ before writing Expo code. This change uses only plain `TextInput` props already in the file, so no new Expo API is introduced.
- No test runner for RN components; the pure function is unit-tested with `bun test`, the wired UI is verified manually on device.

---

### Task 1: Pure delta function `computeInputDelta`

**Files:**
- Create: `apps/mobile/src/input.ts`
- Test: `apps/mobile/src/input.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const SENT = '​';`
  - `export interface InputDelta { bytes: string; nextPrev: string; resetField: boolean; }`
  - `export function computeInputDelta(prev: string, next: string): InputDelta;`
    - `bytes`: string to pass to `sendInput` (backspaces `\x7f` first, then inserted text); empty string means send nothing.
    - `nextPrev`: value the caller should store as the new "previous value".
    - `resetField`: when `true`, the caller must force the field `value` back to `SENT`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/input.test.ts`:

```ts
// Run: bun test  (from apps/mobile)
import { describe, expect, test } from 'bun:test';
import { computeInputDelta, SENT } from './input';

describe('computeInputDelta', () => {
  test('single char typed appends to sentinel', () => {
    const d = computeInputDelta(SENT, `${SENT}a`);
    expect(d.bytes).toBe('a');
    expect(d.nextPrev).toBe(`${SENT}a`);
    expect(d.resetField).toBe(false);
  });

  test('dictated block inserts whole phrase', () => {
    const d = computeInputDelta(SENT, `${SENT}hello world`);
    expect(d.bytes).toBe('hello world');
    expect(d.nextPrev).toBe(`${SENT}hello world`);
  });

  test('backspace mid-word sends one delete', () => {
    const d = computeInputDelta(`${SENT}abc`, `${SENT}ab`);
    expect(d.bytes).toBe('\x7f');
    expect(d.resetField).toBe(false);
  });

  test('live dictation replacement: delete then insert', () => {
    // "helo" refined to "hello"
    const d = computeInputDelta(`${SENT}helo`, `${SENT}hello`);
    expect(d.bytes).toBe('\x7flo');
  });

  test('sentinel eaten (backspace at empty) sends one delete and resets', () => {
    const d = computeInputDelta(SENT, '');
    expect(d.bytes).toBe('\x7f');
    expect(d.nextPrev).toBe(SENT);
    expect(d.resetField).toBe(true);
  });

  test('no change sends nothing', () => {
    const d = computeInputDelta(`${SENT}ab`, `${SENT}ab`);
    expect(d.bytes).toBe('');
  });

  test('multi-char backspace (autocorrect deletes tail)', () => {
    const d = computeInputDelta(`${SENT}teh`, `${SENT}t`);
    expect(d.bytes).toBe('\x7f\x7f');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && bun test src/input.test.ts`
Expected: FAIL — cannot resolve `./input` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/src/input.ts`:

```ts
// Zero-width sentinel kept in the hidden capture field so it's never "empty" —
// lets iOS fire onChangeText for Backspace even with nothing typed yet, and
// gives the delta a stable prefix to diff against.
export const SENT = '​';

export interface InputDelta {
  // Bytes to forward to the PTY: backspaces (\x7f) first, then inserted text.
  // Empty string means nothing to send.
  bytes: string;
  // The value the caller should store as the new "previous value".
  nextPrev: string;
  // When true, the caller must force the field value back to SENT.
  resetField: boolean;
}

// Turn a capture-field mutation (prev -> next) into PTY bytes. Both prev and a
// well-formed next start with SENT. Covers typing (insert 1), dictation /
// swipe (insert a block), live dictation replacement and autocorrect
// (delete N + insert M), and Backspace (delete 1, or delete-at-empty).
export function computeInputDelta(prev: string, next: string): InputDelta {
  // Sentinel eaten: the field lost its SENT prefix, so Backspace fired with no
  // real content. Send one delete and re-anchor the field.
  if (next === '' || !next.startsWith(SENT)) {
    return { bytes: '\x7f', nextPrev: SENT, resetField: true };
  }

  // Longest common prefix; everything after it in prev was removed and
  // everything after it in next was inserted.
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev[p] === next[p]) p++;

  const removed = prev.length - p;
  const inserted = next.slice(p);
  return {
    bytes: '\x7f'.repeat(removed) + inserted,
    nextPrev: next,
    resetField: false,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && bun test src/input.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/src/input.ts apps/mobile/src/input.test.ts
git commit -m "feat(mobile): pure computeInputDelta for diff-based terminal input"
```

---

### Task 2: Wire the delta into the capture field in `App.tsx`

**Files:**
- Modify: `apps/mobile/App.tsx` — imports (~line 31), remove local `SENT` (line 43), refs near `inputText` state (~line 222), `handleKeyPress` (~line 669), `resetField`/`handleSend` (~line 684), the hidden `TextInput` props (~line 1210).

**Interfaces:**
- Consumes from Task 1: `computeInputDelta`, `SENT`, `InputDelta`.
- Produces: no exports; internal wiring only.

- [ ] **Step 1: Import from `input.ts` and drop the local sentinel**

Add to the import block (near `App.tsx:32`, next to the other `./src/...` imports):

```tsx
import { computeInputDelta, SENT } from './src/input';
```

Then delete the local sentinel definition at `App.tsx:41-43` (the two comment lines and `const SENT = '​';`). `SENT` now comes from the import. Leave `KEY_*` constants intact.

- [ ] **Step 2: Add the two refs**

Immediately after the `inputText` state declaration (`App.tsx:222`, `const [inputText, setInputText] = useState(SENT);`), add:

```tsx
  // Mirrors the field's last value so onChangeText can diff against it.
  const prevValueRef = useRef(SENT);
  // Set when handleKeyPress has already emitted a Ctrl-combo byte, so the
  // following onChangeText absorbs that char without re-sending it.
  const skipNextChangeRef = useRef(false);
```

(`useRef` is already imported — see `App.tsx:1`.)

- [ ] **Step 3: Narrow `handleKeyPress` to Ctrl-combos only**

Replace the whole `handleKeyPress` function (`App.tsx:669-681`) with:

```tsx
  const handleKeyPress = (e: { nativeEvent: { key: string } }) => {
    const key = e.nativeEvent.key;
    // Only Ctrl-combos are handled here now; all printable text and Backspace
    // are handled by the onChangeText delta (see resetField/onChangeText).
    if (ctrlArmed) {
      setCtrlArmed(false);
      if (/^[a-zA-Z]$/.test(key)) {
        sendInput(String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64));
        autoScroll.current = true;
        // The printed letter still lands in the field and will fire
        // onChangeText next — swallow it there instead of sending it literally.
        skipNextChangeRef.current = true;
      }
      // Non-letter while armed: fall through, modifier dropped.
    }
  };
```

- [ ] **Step 4: Replace `resetField` with the delta handler**

Replace `resetField` (`App.tsx:684`, `const resetField = () => setInputText(SENT);`) with:

```tsx
  const resetField = () => {
    setInputText(SENT);
    prevValueRef.current = SENT;
  };

  // Every field mutation (typing, dictation, swipe, autocorrect, Backspace)
  // arrives here. Diff against the previous value and forward the delta.
  const handleChangeText = (next: string) => {
    if (skipNextChangeRef.current) {
      // A Ctrl-combo already emitted its byte; absorb the trailing char.
      skipNextChangeRef.current = false;
      prevValueRef.current = next;
      return;
    }
    const { bytes, nextPrev, resetField: doReset } = computeInputDelta(
      prevValueRef.current,
      next,
    );
    if (bytes) {
      sendInput(bytes);
      autoScroll.current = true;
    }
    if (doReset) {
      resetField();
    } else {
      prevValueRef.current = nextPrev;
    }
  };
```

- [ ] **Step 5: Collapse the field on Enter**

`handleSend` (`App.tsx:687-691`) already calls `resetField()`; with Step 4 that now also re-anchors `prevValueRef`. Confirm `handleSend` reads:

```tsx
  const handleSend = () => {
    autoScroll.current = true;
    sendInput('\r');
    resetField();
  };
```

No edit needed if it already matches; otherwise make it match.

- [ ] **Step 6: Point the hidden `TextInput` at the delta handler**

In the hidden capture field (`App.tsx:1210-1223`), change the `onChangeText` prop from `resetField` to `handleChangeText`. Leave every other prop unchanged:

```tsx
          <TextInput
            ref={inputRef}
            style={styles.hiddenInput}
            value={inputText}
            onKeyPress={handleKeyPress}
            onChangeText={handleChangeText}
            onSubmitEditing={handleSend}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            blurOnSubmit={false}
            keyboardAppearance="dark"
          />
```

- [ ] **Step 7: Typecheck**

Run: `cd apps/mobile && bun run lint`
Expected: PASS — no TypeScript errors. (Fix any unused-variable error, e.g. if `resetField` ends up unreferenced, by confirming it is still used by `handleSend` and `handleChangeText`.)

- [ ] **Step 8: Manual device verification**

Run: `cd apps/mobile && npx expo run:ios --device`
Then in a session, confirm each:
1. Tap terminal → keyboard appears; tap the mic and dictate a phrase → full text lands in the shell.
2. Type normally → characters appear instantly, none doubled.
3. Backspace mid-word deletes one char; Backspace at empty deletes one char server-side (no crash).
4. Arm Ctrl, press `c` → interrupts running process; no stray `c` echoed.
5. Press Enter → command runs; field re-anchors (next keystroke behaves normally).
6. Swipe-type a word → word lands intact.

- [ ] **Step 9: Commit**

```bash
cd /home/samuelloranger/sites/tether
git add apps/mobile/App.tsx
git commit -m "feat(mobile): diff-based capture field enables voice/swipe/autocomplete"
```

---

## Self-Review

**Spec coverage:**
- Problem (bulk text discarded) → Task 1 delta function + Task 2 `onChangeText` wiring. ✓
- `prevValue` ref, sentinel floor → Task 2 Step 2 + `computeInputDelta`. ✓
- Sentinel-eaten backspace branch → Task 1 impl + test; Task 2 `resetField` on `doReset`. ✓
- Normal delta (typing/dictation/swipe/autocorrect/backspace) → Task 1 tests cover all five shapes. ✓
- `handleKeyPress` narrowed to Ctrl only + `skipNextChange` flag → Task 2 Steps 3-4. ✓
- Collapse on Enter → Task 2 Step 5. ✓
- Untouched server/paste/resize → not modified. ✓
- Manual verification steps → Task 2 Step 8 mirrors the spec's 6 checks. ✓

**Placeholder scan:** none — all code and commands are concrete.

**Type consistency:** `computeInputDelta(prev, next): InputDelta` and `SENT` used identically in Task 1 (definition/tests) and Task 2 (import/call). `handleChangeText`, `prevValueRef`, `skipNextChangeRef` names consistent across steps. ✓

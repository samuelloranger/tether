# Diff-based terminal input — enable voice / swipe / autocomplete

**Date:** 2026-07-10
**Scope:** `apps/mobile/App.tsx` (mobile client only)
**Board task:** #150

## Problem

The mobile terminal has no visible input box. A hidden `TextInput` (the
"capture field", `App.tsx` ~line 1210) grabs keyboard focus when the terminal
is tapped. Today it wires typing to the PTY **per keystroke** via `onKeyPress`
(`handleKeyPress`), while `onChangeText={resetField}` simply wipes the field
back to a zero-width sentinel (`SENT = '​'`, line 43) — discarding whatever
text landed in it.

Voice dictation never fires `onKeyPress`. Neither do swipe-typing, autocomplete,
or autocorrect. All of them deliver a **block of text through `onChangeText`**.
Because `onChangeText` throws that text away, dictated/swiped/completed input is
silently lost. That is why "voice on the keyboard does not work."

## Approach

Stop treating the field as a per-keystroke wire. Let it hold text and, on every
`onChangeText`, compute the **delta** between the previous value and the new
value and send that delta to the PTY. Typing, dictation, swipe, and autocorrect
all present as text changes, so all four begin working from one code path. As a
bonus this is more Android-portable than `onKeyPress` (Android only reliably
reports Backspace through `onKeyPress`).

The tradeoff considered and rejected was an additive "mic button" mode (separate
dictation field, submit-on-done). It is zero-risk to existing typing but makes
voice a deliberate mode rather than inline keyboard-mic, and leaves swipe /
autocomplete still broken. Diff-based fixes the whole class at once.

## Design

All changes are in `apps/mobile/App.tsx`. Server, PTY, resize, and paste paths
are untouched.

### State

- Add `prevValueRef` (a `useRef`) seeded to `SENT`. It mirrors what the field
  last contained, so each `onChangeText` can diff against it.
- Add `skipNextChangeRef` (a `useRef<boolean>`), default `false`. Set when
  `onKeyPress` has already handled a Ctrl-combo, so the immediately-following
  `onChangeText` absorbs that character into `prevValue` **without** re-sending
  it as a literal byte.
- The field `value` stays anchored to `SENT` as a floor so a Backspace with no
  real content still produces a detectable change.

### `onChangeText(next)`

1. **Skip flag set** (Ctrl-combo already fired): set `prevValueRef = next`, clear
   the flag, return. (Character is absorbed, not sent — the control byte was
   already emitted in `handleKeyPress`.)
2. **Sentinel eaten** — `next` is empty or does not start with `SENT`: treat as
   Backspace at empty. Send `\x7f`, force the field and `prevValueRef` back to
   `SENT`, return.
3. **Normal delta** — both `prevValue` and `next` start with `SENT`:
   - `p` = length of the common prefix of `prevValue` and `next`.
   - `removed` = `prevValue.length - p` → send `\x7f` that many times.
   - `inserted` = `next.slice(p)` → send it (empty string sends nothing).
   - Set `prevValueRef = next` (let the field accumulate).

   This single branch covers: normal typing (insert 1), live dictation
   replacement (delete N + insert M as iOS refines the transcription),
   swipe-type (insert a word), autocorrect fixups (delete + insert), and
   mid-line Backspace (delete 1).

### `handleKeyPress(e)`

Strip the `Backspace` branch and the `key.length === 1` printable branch — the
diff now owns both; keeping them would double-send. Keep **only** the
`ctrlArmed` transform. When it fires and sends a control byte, set
`skipNextChangeRef = true` before returning so the trailing `onChangeText`
swallows the printed character. Preserve the existing `autoScroll` behavior.

Ordering guarantee this relies on: on iOS, `onKeyPress` fires **before** the
text update / `onChangeText` for the same key. The skip flag is therefore always
set before the change it needs to suppress arrives.

### `handleSend()` (Return key)

Unchanged in intent: send `\r`. Additionally collapse the field and
`prevValueRef` back to `SENT`. This bounds field growth to a single command line
between Enters (the field is hidden, so accumulation is invisible, but this keeps
it tidy and re-anchors the sentinel floor).

### `resetField`

Retained where still referenced, but `onChangeText` no longer points at it — it
points at the new delta handler.

## Components / boundaries

- **Delta handler (`onChangeText`)** — the one place that turns field mutations
  into PTY bytes. Input: previous value + new value. Output: `sendInput(...)`
  calls. Depends on: `SENT`, `prevValueRef`, `skipNextChangeRef`, `sendInput`.
- **Key handler (`handleKeyPress`)** — now narrowed to Ctrl-combo transforms
  only. Signals the delta handler via `skipNextChangeRef`.
- **Send handler (`handleSend`)** — emits `\r` and re-anchors state.

Each is small and independently reasoned about; the only shared state is the two
refs and `SENT`.

## Error handling / edge cases

- Backspace at empty content → sentinel-eaten branch → single `\x7f`.
- Rapid dictation with progressive replacement → delta handles arbitrary
  delete-then-insert per change.
- Ctrl-combo during an active dictation is not a realistic sequence; the skip
  flag still keeps state consistent if it happens.
- Unbounded field growth → collapsed on every Enter.

## Testing / verification

No test runner exists in this repo and this is device-level UI, so verification
is manual on a connected iOS device (`cd apps/mobile && npx expo run:ios
--device`):

1. Dictate a phrase → full text lands in the shell.
2. Type normally → characters appear instantly, none doubled.
3. Backspace mid-word, and Backspace at empty → each deletes exactly one.
4. Ctrl-C (arm Ctrl, then `c`) → interrupts; no stray `c` echoed.
5. Enter → command runs; field re-anchors.
6. Swipe-type a word → word lands intact.

Primary risk is the double-send reconciliation (skip flag + iOS ordering); steps
2 and 4 are the hard checks.

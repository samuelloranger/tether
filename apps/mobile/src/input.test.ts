// Run: bun run src/input.test.ts  (from apps/mobile)
import {
  applyBackspaceStreak,
  applyFieldChange,
  computeInputDelta,
  EMPTY_STREAK,
  SENT,
  STREAK_THRESHOLD,
} from './input';

let pass = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${msg}\n  expected ${b}\n  got      ${a}`);
  pass++;
}

// 1. Single char typed appends to sentinel
{
  const d = computeInputDelta(SENT, `${SENT}a`);
  eq(d.bytes, 'a', 'single char bytes');
  eq(d.nextPrev, `${SENT}a`, 'single char nextPrev');
  eq(d.resetField, false, 'single char no reset');
}

// 2. Dictated block inserts the whole phrase
{
  const d = computeInputDelta(SENT, `${SENT}hello world`);
  eq(d.bytes, 'hello world', 'dictated block bytes');
  eq(d.nextPrev, `${SENT}hello world`, 'dictated block nextPrev');
}

// 3. Backspace mid-word sends one delete
{
  const d = computeInputDelta(`${SENT}abc`, `${SENT}ab`);
  eq(d.bytes, '\x7f', 'backspace one delete');
  eq(d.resetField, false, 'backspace no reset');
}

// 4. Live dictation replacement: delete then insert ("helo" -> "hello")
{
  const d = computeInputDelta(`${SENT}helo`, `${SENT}hello`);
  eq(d.bytes, '\x7flo', 'dictation replacement delete+insert');
}

// 5. Sentinel eaten (backspace at empty) sends one delete and resets
{
  const d = computeInputDelta(SENT, '');
  eq(d.bytes, '\x7f', 'sentinel eaten delete');
  eq(d.nextPrev, SENT, 'sentinel eaten re-anchors');
  eq(d.resetField, true, 'sentinel eaten resets field');
}

// 6. No change sends nothing
{
  const d = computeInputDelta(`${SENT}ab`, `${SENT}ab`);
  eq(d.bytes, '', 'no change sends nothing');
}

// 7. Multi-char backspace (autocorrect deletes tail)
{
  const d = computeInputDelta(`${SENT}teh`, `${SENT}t`);
  eq(d.bytes, '\x7f\x7f', 'multi-char backspace');
}

// --- applyFieldChange: models the controlled-value loop ---
// The hidden TextInput is controlled by `value`. After each onChangeText the
// caller must set BOTH the controlled value and the previous-value ref to the
// returned `value`, or React Native reverts the native field to the old value
// and the next diff is computed against a stale prev (spurious deletes).
// This helper drives that loop: `field` = what the native field shows before an
// edit, which equals the last applied `value`.
function drive(edits: ((field: string) => string)[]): string {
  let value = SENT;
  let sent = '';
  for (const edit of edits) {
    const next = edit(value); // user mutates the field currently showing `value`
    const r = applyFieldChange(value, next);
    sent += r.bytes;
    value = r.value; // caller syncs controlled value + prev ref
  }
  return sent;
}

// 8. Sequential typing appends without a spurious delete (the PR#5 P1 bug)
{
  eq(drive([(f) => `${f}a`, (f) => `${f}b`]), 'ab', 'typing "ab" sends "ab"');
}

// 9. Dictated phrase then another word both survive
{
  eq(
    drive([(f) => `${f}hello`, (f) => `${f} world`]),
    'hello world',
    'dictation accumulates across changes',
  );
}

// 10. Backspace after typing deletes exactly one char
{
  eq(drive([(f) => `${f}ab`, (f) => f.slice(0, -1)]), 'ab\x7f', 'type "ab" then backspace');
}

// 11. applyFieldChange keeps value in step with prev (no snap-back to SENT)
{
  const r = applyFieldChange(SENT, `${SENT}a`);
  eq(r.bytes, 'a', 'first char bytes');
  eq(r.value, `${SENT}a`, 'value advances so the field will not snap back to SENT');
}

// 12. Sentinel eaten re-anchors the controlled value to SENT
{
  const r = applyFieldChange(SENT, '');
  eq(r.bytes, '\x7f', 'backspace at empty sends one delete');
  eq(r.value, SENT, 'value re-anchored to sentinel');
}

// 13. Below threshold, empty-buffer backspaces pass through unchanged
{
  let s = EMPTY_STREAK;
  for (let i = 0; i < STREAK_THRESHOLD; i++) {
    const r = applyBackspaceStreak(s, '\x7f', true, 1000 + i * 100);
    eq(r.bytes, '\x7f', `streak pass-through at ${i}`);
    s = r.streak;
  }
}

// 14. Past threshold, empty-buffer backspace upgrades to Ctrl+W (word delete)
{
  let last = { streak: EMPTY_STREAK, bytes: '' };
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    last = applyBackspaceStreak(last.streak, '\x7f', true, 1000 + i * 100);
  }
  eq(last.bytes, '\x17', 'streak upgrades to word delete past threshold');
}

// 15. A gap >= 150ms resets the streak
{
  let s = EMPTY_STREAK;
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    ({ streak: s } = applyBackspaceStreak(s, '\x7f', true, 1000 + i * 100));
  }
  const r = applyBackspaceStreak(s, '\x7f', true, 100000);
  eq(r.bytes, '\x7f', 'gap resets streak to char delete');
}

// 16. Any non-backspace bytes reset the streak
{
  let s = EMPTY_STREAK;
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    ({ streak: s } = applyBackspaceStreak(s, '\x7f', true, 1000 + i * 100));
  }
  const typed = applyBackspaceStreak(s, 'a', false, 2600);
  eq(typed.bytes, 'a', 'typing passes through');
  const after = applyBackspaceStreak(typed.streak, '\x7f', true, 2700);
  eq(after.bytes, '\x7f', 'typing reset the streak');
}

// 17. Deletes that consume local buffer (fromEmptyBuffer=false) never upgrade
// and never build the streak, even when rapid — a long-press through typed
// text stays char-precise.
{
  let s = EMPTY_STREAK;
  for (let i = 0; i <= STREAK_THRESHOLD + 5; i++) {
    const r = applyBackspaceStreak(s, '\x7f', false, 1000 + i * 100);
    eq(r.bytes, '\x7f', `buffer-consuming delete stays char delete at ${i}`);
    s = r.streak;
  }
}

// 18. A buffer-consuming delete resets a streak already past threshold, so
// word-delete does not carry over once local text starts being consumed again.
{
  let s = EMPTY_STREAK;
  for (let i = 0; i <= STREAK_THRESHOLD; i++) {
    ({ streak: s } = applyBackspaceStreak(s, '\x7f', true, 1000 + i * 100));
  }
  const consuming = applyBackspaceStreak(s, '\x7f', false, 2600);
  eq(consuming.bytes, '\x7f', 'buffer-consuming delete resets past-threshold streak');
  const next = applyBackspaceStreak(consuming.streak, '\x7f', true, 2700);
  eq(next.bytes, '\x7f', 'streak restarts from 1 after buffer consumption');
}

// 19. applyFieldChange surfaces fromEmptyBuffer: true only on the sentinel-eaten
// path (empty buffer), false when a real char is removed from local text.
{
  const eaten = applyFieldChange(SENT, '');
  eq(eaten.fromEmptyBuffer, true, 'sentinel eaten is empty-buffer');
  const midWord = applyFieldChange(`${SENT}abc`, `${SENT}ab`);
  eq(midWord.fromEmptyBuffer, false, 'consuming local text is not empty-buffer');
}


console.log(`\n  ${pass} assertions passed\n`);

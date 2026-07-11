// Run: bun run src/input.test.ts  (from apps/mobile)
import { computeInputDelta, SENT } from './input';

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

console.log(`\n  ${pass} assertions passed\n`);

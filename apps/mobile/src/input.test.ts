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

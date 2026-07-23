import { expect, test } from 'bun:test';
import { TerminalEmulator } from './terminal';

function screenText(t: TerminalEmulator): string {
  return t
    .getSnapshot()
    .map((r) =>
      r.runs
        .map((x) => x.text)
        .join('')
        .replace(/\s+$/, ''),
    )
    .join('\n')
    .replace(/\n+$/, '');
}

test('unterminated OSC does not grow the parser buffer without bound', () => {
  const t = new TerminalEmulator(80, 24);
  // ESC ] then a megabyte of payload with no terminator.
  t.write(`\x1b]0;${'A'.repeat(1_000_000)}`);
  // The sequence is abandoned on overflow; a following ST + text still renders.
  t.write('\x1b\\hello');
  expect(screenText(t)).toContain('hello');
});

test('unterminated CSI params do not grow without bound', () => {
  const t = new TerminalEmulator(80, 24);
  t.write(`\x1b[${'1;'.repeat(1_000_000)}`);
  t.write('world');
  expect(screenText(t)).toContain('world');
});

test('mouse mode: maps each DECSET mode to the right mouseMode', () => {
  let t = new TerminalEmulator(80, 24);
  t.write('\x1b[?9h');
  expect(t.mouseMode).toBe('x10');
  t = new TerminalEmulator(80, 24);
  t.write('\x1b[?1000h');
  expect(t.mouseMode).toBe('normal');
  t = new TerminalEmulator(80, 24);
  t.write('\x1b[?1002h');
  expect(t.mouseMode).toBe('button');
  t = new TerminalEmulator(80, 24);
  t.write('\x1b[?1003h');
  expect(t.mouseMode).toBe('any');
});

test('mouse mode: mouseOn getter tracks mouseMode', () => {
  const t = new TerminalEmulator(80, 24);
  expect(t.mouseOn).toBe(false);
  t.write('\x1b[?1000h');
  expect(t.mouseOn).toBe(true);
  t.write('\x1b[?1000l');
  expect(t.mouseMode).toBe('off');
  expect(t.mouseOn).toBe(false);
});

test('mouse mode: tracks SGR encoding independently', () => {
  const t = new TerminalEmulator(80, 24);
  t.write('\x1b[?1006h');
  expect(t.mouseSgr).toBe(true);
  t.write('\x1b[?1006l');
  expect(t.mouseSgr).toBe(false);
});

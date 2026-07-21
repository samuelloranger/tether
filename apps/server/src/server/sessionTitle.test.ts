import { describe, expect, test } from 'bun:test';
import {
  autoTitle,
  clearTitle,
  getOscTitle,
  INITIAL_TITLE_STATE,
  recordTitleChunk,
  updateTitle,
} from './sessionTitle';

describe('updateTitle', () => {
  test('captures OSC 2 title with BEL terminator', () => {
    const next = updateTitle(INITIAL_TITLE_STATE, 'before\x1b]2;vim: pty.ts\x07after');
    expect(next.title).toBe('vim: pty.ts');
    expect(next.changed).toBe(true);
  });

  test('captures OSC 0 title with ST terminator', () => {
    const next = updateTitle(INITIAL_TITLE_STATE, '\x1b]0;claude — tether\x1b\\');
    expect(next.title).toBe('claude — tether');
  });

  test('last title in a chunk wins', () => {
    const next = updateTitle(INITIAL_TITLE_STATE, '\x1b]2;one\x07\x1b]2;two\x07');
    expect(next.title).toBe('two');
  });

  test('sequence split across two chunks is reassembled', () => {
    const mid = updateTitle(INITIAL_TITLE_STATE, 'x\x1b]2;spl');
    expect(mid.title).toBeNull();
    const next = updateTitle(mid, 'it title\x07y');
    expect(next.title).toBe('split title');
  });

  test('empty payload clears the title back to null', () => {
    const set = updateTitle(INITIAL_TITLE_STATE, '\x1b]2;hello\x07');
    const cleared = updateTitle(set, '\x1b]0;\x07');
    expect(cleared.title).toBeNull();
    expect(cleared.changed).toBe(true);
  });

  test('strips control characters and trims whitespace', () => {
    const next = updateTitle(INITIAL_TITLE_STATE, '\x1b]2;  a\x01b\ttitle  \x07');
    expect(next.title).toBe('ab\ttitle');
  });

  test('whitespace-only payload after sanitization reads as clear', () => {
    const set = updateTitle(INITIAL_TITLE_STATE, '\x1b]2;real\x07');
    const next = updateTitle(set, '\x1b]2;  \x01 \x07');
    expect(next.title).toBeNull();
  });

  test('caps title at 128 chars', () => {
    const next = updateTitle(INITIAL_TITLE_STATE, `\x1b]2;${'a'.repeat(500)}\x07`);
    expect(next.title).toHaveLength(128);
  });

  test('ignores other OSC sequences (7, 133) and reports no change', () => {
    const next = updateTitle(
      INITIAL_TITLE_STATE,
      '\x1b]7;file://host/tmp\x07\x1b]133;A\x07plain text',
    );
    expect(next.title).toBeNull();
    expect(next.changed).toBe(false);
  });

  test('same title again reports no change', () => {
    const set = updateTitle(INITIAL_TITLE_STATE, '\x1b]2;same\x07');
    const again = updateTitle(set, '\x1b]2;same\x07');
    expect(again.title).toBe('same');
    expect(again.changed).toBe(false);
  });

  test('residual buffer is bounded', () => {
    const mid = updateTitle(INITIAL_TITLE_STATE, `\x1b]2;${'b'.repeat(10_000)}`);
    expect(mid.residual.length).toBeLessThanOrEqual(4096);
  });
});

describe('per-session store', () => {
  test('recordTitleChunk stores and getOscTitle reads back', () => {
    clearTitle('s1');
    expect(getOscTitle('s1')).toBeNull();
    expect(recordTitleChunk('s1', '\x1b]2;hi\x07')).toBe(true);
    expect(getOscTitle('s1')).toBe('hi');
    expect(recordTitleChunk('s1', 'no title here')).toBe(false);
    clearTitle('s1');
    expect(getOscTitle('s1')).toBeNull();
  });
});

describe('autoTitle', () => {
  test('OSC title wins', () => {
    expect(autoTitle('vim', '/home/sam/sites/tether', 'bash')).toBe('vim');
  });

  test('falls back to cwd basename', () => {
    expect(autoTitle(null, '/home/sam/sites/tether', 'bash')).toBe('tether');
  });

  test('falls back to command when no cwd', () => {
    expect(autoTitle(null, null, 'bash')).toBe('bash');
  });

  test('root cwd falls back to command (basename of / is empty)', () => {
    expect(autoTitle(null, '/', 'zsh')).toBe('zsh');
  });
});

test('sequence split at the lone ESC byte is reassembled', () => {
  const mid = updateTitle(INITIAL_TITLE_STATE, 'text\x1b');
  const next = updateTitle(mid, ']0;esc-split\x07');
  expect(next.title).toBe('esc-split');
});

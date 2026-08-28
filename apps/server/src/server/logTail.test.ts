import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { followFile, lastLines, readLastLines } from './logTail';

const dirs: string[] = [];

function tempFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-logtail-'));
  dirs.push(dir);
  const file = path.join(dir, 'server.log');
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('lastLines', () => {
  test('returns the whole thing when the input has fewer lines than asked for', () => {
    expect(lastLines('a\nb\n', 80)).toBe('a\nb\n');
  });

  test('keeps only the trailing n lines when there are more', () => {
    expect(lastLines('a\nb\nc\nd\n', 2)).toBe('c\nd\n');
  });

  test('empty in, empty out — an untouched log prints nothing, not a blank line', () => {
    expect(lastLines('', 80)).toBe('');
    expect(lastLines('', 0)).toBe('');
  });

  test('a trailing newline terminates the last line, it does not start a new one', () => {
    // The naive split('\n') gets this wrong: it sees a trailing '' element and
    // spends one of the n slots on it, so `tail -n 1` prints an empty line.
    expect(lastLines('a\nb\n', 1)).toBe('b\n');
  });

  test('a file with no trailing newline keeps its last line unterminated', () => {
    expect(lastLines('a\nb', 1)).toBe('b');
    expect(lastLines('a\nb\nc', 2)).toBe('b\nc');
  });

  test('n <= 0 yields nothing', () => {
    expect(lastLines('a\nb\n', 0)).toBe('');
    expect(lastLines('a\nb\n', -1)).toBe('');
  });
});

describe('readLastLines', () => {
  test('a file shorter than n comes back whole, with the size to follow from', () => {
    const file = tempFile('one\ntwo\n');
    const tail = readLastLines(file, 80);
    expect(tail.text).toBe('one\ntwo\n');
    expect(tail.size).toBe(8);
  });

  test('a file longer than n is cut to the last n lines', () => {
    // 5000 lines is well past the 64 KiB backwards-read chunk, so this also
    // covers the multi-chunk walk rather than a single lucky read.
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const file = tempFile(`${lines.join('\n')}\n`);
    const tail = readLastLines(file, 80);
    expect(tail.text.split('\n').filter(Boolean)).toHaveLength(80);
    expect(tail.text.startsWith('line 4920\n')).toBe(true);
    expect(tail.text.endsWith('line 4999\n')).toBe(true);
  });

  test('an empty log reads as empty, not as a stray newline', () => {
    const tail = readLastLines(tempFile(''), 80);
    expect(tail.text).toBe('');
    expect(tail.size).toBe(0);
  });

  test('a log with no trailing newline keeps its last line', () => {
    const file = tempFile('one\ntwo\nthree');
    expect(readLastLines(file, 2).text).toBe('two\nthree');
  });

  test('multi-byte characters survive a chunk boundary', () => {
    // The backwards read is byte-oriented; decoding each chunk on its own would
    // split a UTF-8 sequence straddling the boundary into replacement chars.
    const line = `${'é'.repeat(1000)}\n`;
    const file = tempFile(line.repeat(200));
    const tail = readLastLines(file, 3);
    expect(tail.text).toBe(line.repeat(3));
    expect(tail.text).not.toContain('�');
  });
});

describe('followFile', () => {
  test('emits the tail, then every appended byte', async () => {
    const file = tempFile('old\n');
    const seen: string[] = [];
    const handle = followFile(file, { lines: 80, intervalMs: 5, write: (c) => seen.push(c) });
    try {
      expect(seen).toEqual(['old\n']);
      appendFileSync(file, 'new\n');
      await sleep(60);
      expect(seen.join('')).toBe('old\nnew\n');
      appendFileSync(file, 'newer\n');
      await sleep(60);
      expect(seen.join('')).toBe('old\nnew\nnewer\n');
    } finally {
      handle.stop();
    }
  });

  test('stop() ends the stream', async () => {
    const file = tempFile('old\n');
    const seen: string[] = [];
    const handle = followFile(file, { intervalMs: 5, write: (c) => seen.push(c) });
    handle.stop();
    appendFileSync(file, 'ignored\n');
    await sleep(40);
    expect(seen.join('')).toBe('old\n');
  });

  test('re-reads from the top when the log is truncated in place', async () => {
    const file = tempFile('old\n'.repeat(10));
    const seen: string[] = [];
    const handle = followFile(file, { lines: 2, intervalMs: 5, write: (c) => seen.push(c) });
    try {
      seen.length = 0;
      truncateSync(file, 0);
      writeFileSync(file, 'fresh\n');
      await sleep(60);
      expect(seen.join('')).toBe('fresh\n');
    } finally {
      handle.stop();
    }
  });
});

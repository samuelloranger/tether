import { expect, test } from 'bun:test';
import './xtermPolyfill';
import { Terminal } from '@xterm/headless';

// xterm buffers writes and flushes on a later tick; await the write callback.
function flush(t: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => t.write(data, resolve));
}

test('xterm headless imports and writes under the shim', async () => {
  const t = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  expect(t.cols).toBe(20);
  await flush(t, 'hi');
  expect(t.buffer.active.getLine(0)?.translateToString(true)).toContain('hi');
});

import { TerminalEngine } from './terminalEngine';

const E = '\x1b';
async function write(t: TerminalEngine, data: string): Promise<void> {
  t.write(data);
  await t.drain();
}
function rowText(t: TerminalEngine, i: number): string {
  return t.getSnapshot()[i].runs.map((r) => r.text).join('').replace(/\s+$/, '');
}

test('plain text lands on row 0', async () => {
  const t = new TerminalEngine(20, 5);
  await write(t, 'hello');
  expect(rowText(t, 0)).toBe('hello');
});

test('truecolor SGR sets run fg', async () => {
  const t = new TerminalEngine(20, 5);
  await write(t, `${E}[38;2;255;0;0mR${E}[0m`);
  const runs = t.getSnapshot()[0].runs.filter((r) => r.text.trim() !== '');
  expect(runs[0].text).toBe('R');
  expect(runs[0].style.fg?.toLowerCase()).toBe('#ff0000');
});

test('bold + wide char occupy correct columns', async () => {
  const t = new TerminalEngine(20, 5);
  await write(t, `${E}[1mAB${E}[0m你`);
  const s = t.getSnapshot()[0];
  const text = s.runs.map((r) => r.text).join('');
  expect(text.startsWith('AB你')).toBe(true);
  expect(s.runs.find((r) => r.text.includes('A'))?.style.bold).toBe(true);
});

function findRow(t: TerminalEngine, needle: string) {
  return t.getSnapshot().find((r) => r.runs.map((x) => x.text).join('').includes(needle));
}

test('row key is stable when a line scrolls into scrollback', async () => {
  const t = new TerminalEngine(20, 2);
  await write(t, 'one\r\n');
  const key1 = findRow(t, 'one')!.key;
  await write(t, 'two\r\nthree\r\n');
  const key2 = findRow(t, 'one')!.key;
  expect(key2).toBe(key1);
});

test('logical key survives scrollback trim (>cap lines)', async () => {
  const t = new TerminalEngine(20, 3);
  await write(t, 'MARK\r\n');
  const markKey = findRow(t, 'MARK')!.key;
  for (let i = 0; i < 1200; i++) t.write(`fill${i}\r\n`);
  await t.drain();
  // MARK long since trimmed away; its key must never be reused by a live row.
  const liveKeys = t.getSnapshot().map((r) => r.key);
  expect(Math.min(...liveKeys)).toBeGreaterThan(markKey);
});

test('URL produces a link span', async () => {
  const t = new TerminalEngine(60, 3);
  await write(t, 'see https://example.com now');
  const row = t.getSnapshot()[0];
  expect(row.links.length).toBeGreaterThan(0);
  const target = row.links[0].target;
  expect(target.kind).toBe('external');
  expect(target.kind === 'external' && target.url).toBe('https://example.com');
});

test('OSC 133;A marks promptStart and jumpToPrompt finds it', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b]133;A\x07$ cmd\r\nout\r\n');
  const snap = t.getSnapshot();
  const promptRow = snap.findIndex((r) => r.promptStart);
  expect(promptRow).toBeGreaterThanOrEqual(0);
  expect(t.jumpToPrompt(snap.length - 1, -1)).toBe(promptRow);
});

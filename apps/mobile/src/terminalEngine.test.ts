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

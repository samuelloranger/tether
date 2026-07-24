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

test('DECCKM sets applicationCursor', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b[?1h');
  expect(t.applicationCursor).toBe(true);
  await write(t, '\x1b[?1l');
  expect(t.applicationCursor).toBe(false);
});

test('bracketed paste mode 2004', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b[?2004h');
  expect(t.bracketedPaste).toBe(true);
});

test('SGR mouse mode 1006 + 1000', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b[?1000h\x1b[?1006h');
  expect(t.mouseOn).toBe(true);
  expect(t.mouseMode).toBe('normal');
  expect(t.mouseSgr).toBe(true);
});

test('DECSCUSR cursor style bar (6) then block (2)', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b[6 q');
  expect(t.cursorStyle).toBe('bar');
  await write(t, '\x1b[2 q');
  expect(t.cursorStyle).toBe('block');
});

test('OSC 2 sets title, OSC 7 sets cwd', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b]2;My Title\x07');
  expect(t.title).toBe('My Title');
  await write(t, '\x1b]7;file://host/home/sam\x07');
  expect(t.cwd).toBe('/home/sam');
});

test('bell increments bellCount', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x07');
  expect(t.bellCount).toBe(1);
});

test('OSC 777 notify sets lastNotify + count', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b]777;notify;Build done;All green\x07');
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify).toEqual({ title: 'Build done', body: 'All green' });
});

test('OSC 99 kitty notify (chunked: d=0 waits for final)', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b]99;i=1:d=0:p=title;Hello\x07'); // incomplete — buffer only
  expect(t.notifyCount).toBe(0);
  await write(t, '\x1b]99;i=1:p=body;World\x07'); // done — fires once
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify).toEqual({ title: 'Hello', body: 'World' });
});

test('OSC 52 fires onClipboardWrite with decoded text', async () => {
  const t = new TerminalEngine(20, 4);
  let got = '';
  t.onClipboardWrite = (s) => {
    got = s;
  };
  const b64 = Buffer.from('copied').toString('base64');
  await write(t, `\x1b]52;c;${b64}\x07`);
  expect(got).toBe('copied');
});

test('promptReturnCount increments once per OSC 133;A', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b]133;A\x07cmd\r\n\x1b]133;A\x07');
  expect(t.promptReturnCount).toBe(2);
});

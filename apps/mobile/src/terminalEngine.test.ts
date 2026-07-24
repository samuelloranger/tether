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

test('OSC 8 hyperlink → tappable link span (text != url)', async () => {
  const t = new TerminalEngine(40, 4);
  await write(t, `${E}]8;;https://ex.com${E}\\CLICK${E}]8;;${E}\\`);
  const links = t.getSnapshot()[0].links;
  expect(links.length).toBe(1);
  expect(links[0].start).toBe(0);
  expect(links[0].end).toBe(5); // "CLICK"
  const target = links[0].target;
  expect(target.kind === 'external' && target.url).toBe('https://ex.com');
});

test('bell/notify counters are updated by the time write onFlush fires (#1)', async () => {
  const t = new TerminalEngine(20, 4);
  await new Promise<void>((resolve) => {
    t.write('\x07\x1b]777;notify;T;B\x07', () => {
      // onFlush must run AFTER xterm parsed the chunk → counters current.
      expect(t.bellCount).toBe(1);
      expect(t.notifyCount).toBe(1);
      resolve();
    });
  });
});

test('DECTCEM ?25l hides caret; ?25h restores it (#4)', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, 'hi\x1b[?25l');
  expect(t.cursorVisible).toBe(false);
  expect(t.getSnapshot()[0].runs.some((r) => r.style.caret)).toBe(false);
  await write(t, '\x1b[?25h');
  expect(t.cursorVisible).toBe(true);
  expect(t.getSnapshot()[0].runs.some((r) => r.style.caret)).toBe(true);
});

test('OSC 10/11 color query reply uses theme default (#3)', async () => {
  const t = new TerminalEngine(20, 4);
  const replies: string[] = [];
  t.onReply = (d) => replies.push(d);
  await write(t, '\x1b]10;?\x07\x1b]11;?\x07');
  expect(replies.some((r) => r.startsWith('\x1b]10;rgb:'))).toBe(true);
  expect(replies.some((r) => r.startsWith('\x1b]11;rgb:'))).toBe(true);
});

test('OSC 8 link closed after newline is clamped to text, not trailing blanks (#2)', async () => {
  const t = new TerminalEngine(40, 4);
  await write(t, `${E}]8;;https://ex.com${E}\\CLICK\r\n${E}]8;;${E}\\`);
  const links = t.getSnapshot()[0].links;
  expect(links.length).toBe(1);
  expect(links[0].start).toBe(0);
  expect(links[0].end).toBe(5); // "CLICK", not clamped to cols=40
});

test('SGR 7 reverse video swaps fg/bg into resolved colors (#B)', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, `${E}[38;2;255;0;0;48;2;0;0;255mX${E}[7mY${E}[0m`);
  const runs = t.getSnapshot()[0].runs.filter((r) => r.text.trim());
  const x = runs.find((r) => r.text.includes('X'))!;
  const y = runs.find((r) => r.text.includes('Y'))!;
  // X: fg red / bg blue; Y: reversed → fg blue / bg red.
  expect(x.style.fg?.toLowerCase()).toBe('#ff0000');
  expect(x.style.bg?.toLowerCase()).toBe('#0000ff');
  expect(y.style.fg?.toLowerCase()).toBe('#0000ff');
  expect(y.style.bg?.toLowerCase()).toBe('#ff0000');
  expect(y.style.inverse).toBeUndefined(); // resolved, not flagged
});

test('OSC 8 label spanning a newline tags every covered row (#C)', async () => {
  const t = new TerminalEngine(40, 4);
  // label "abc" then newline then "def", closed on row 1
  await write(t, `${E}]8;;https://ex.com${E}\\abc\r\ndef${E}]8;;${E}\\`);
  const snap = t.getSnapshot();
  const r0 = snap[0].links;
  const r1 = snap[1].links;
  expect(r0.length).toBe(1);
  expect(r0[0].start).toBe(0);
  expect(r0[0].end).toBe(3); // "abc"
  expect(r1.length).toBe(1);
  expect(r1[0].start).toBe(0);
  expect(r1[0].end).toBe(3); // "def" also tappable
  const tgt = r1[0].target;
  expect(tgt.kind === 'external' && tgt.url).toBe('https://ex.com');
});

test('OSC 8 span is dropped when the row is repainted over it (#D)', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, `${E}]8;;https://ex.com${E}\\LINK${E}]8;;${E}\\`);
  expect(t.getSnapshot()[0].links.length).toBe(1);
  // Repaint the row: CR to col 0, overwrite the linked cells with plain text.
  await write(t, '\rPLAIN');
  const links = t.getSnapshot()[0].links;
  expect(links.some((l) => l.target.kind === 'external' && l.target.url === 'https://ex.com')).toBe(
    false,
  );
});

test('trailing default blanks are trimmed from row text (#E)', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, 'hi');
  // caret cell keeps 1 trailing space on the cursor row (legacy parity), NOT
  // full-width padding — the 20-col row must not become "hi" + 18 spaces.
  expect(t.getSnapshot()[0].runs.map((r) => r.text).join('')).toBe('hi ');
  // a non-cursor blank row emits no padding at all
  expect(t.getSnapshot()[1].runs.map((r) => r.text).join('')).toBe('');
});

test('alt-screen feeds do not inflate trim / prune normal-buffer prompts (#1)', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b]133;A\x07prompt\r\n');
  const key0 = t.getSnapshot().find((r) => r.promptStart)?.key;
  expect(key0).toBeGreaterThanOrEqual(0);
  await write(t, '\x1b[?1049h'); // enter alt screen
  for (let i = 0; i < 60; i++) t.write('x\r\n');
  await t.drain();
  await write(t, '\x1b[?1049l'); // leave alt screen
  const row = t.getSnapshot().find((r) => r.promptStart);
  expect(row).toBeDefined(); // promptId survived (not pruned by inflated trim)
  expect(row?.key).toBe(key0); // and its logical key is stable
});

test('reset clears half-assembled kitty OSC 99 chunks (#3)', async () => {
  const t = new TerminalEngine(20, 4);
  await write(t, '\x1b]99;i=1:d=0:p=title;Hello\x07'); // incomplete, buffered
  t.reset();
  await write(t, '\x1b]99;i=1:p=body;World\x07'); // final chunk after reset
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify).toEqual({ title: '', body: 'World' }); // no stale "Hello"
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

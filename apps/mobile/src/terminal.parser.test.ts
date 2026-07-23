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

test('scrollback caps: snapshot length stops growing (auto-scroll follow trigger)', () => {
  const rows = 24;
  const t = new TerminalEmulator(80, rows);
  const feed = (n: number) => {
    let s = '';
    for (let i = 0; i < n; i++) s += `line\r\n`;
    t.write(s);
  };
  feed(1500);
  const len1 = t.getSnapshot().length;
  feed(1000);
  const len2 = t.getSnapshot().length;
  // Once scrollback is capped, total rendered rows are constant — this is why a
  // height-change-only follow-tail goes silent during long agent output.
  expect(len1).toBe(len2);
  expect(len1).toBe(1000 + rows); // MAX_SCROLLBACK + screen rows
});

test('OSC 9 (iTerm2) notification: increments notifyCount, sets body', () => {
  const t = new TerminalEmulator(80, 24);
  t.write('\x1b]9;Claude needs your input\x07');
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify).toEqual({ title: '', body: 'Claude needs your input' });
});

test('OSC 9 with ST terminator also fires', () => {
  const t = new TerminalEmulator(80, 24);
  t.write('\x1b]9;hello\x1b\\');
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify.body).toBe('hello');
});

test('OSC 777;notify (rxvt/ghostty): title and body', () => {
  const t = new TerminalEmulator(80, 24);
  t.write('\x1b]777;notify;Claude;needs your input\x1b\\');
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify).toEqual({ title: 'Claude', body: 'needs your input' });
});

test('OSC 777;notify with only a title (no body)', () => {
  const t = new TerminalEmulator(80, 24);
  t.write('\x1b]777;notify;Build finished\x1b\\');
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify).toEqual({ title: 'Build finished', body: '' });
});

test('OSC 777 non-notify subcommand is ignored', () => {
  const t = new TerminalEmulator(80, 24);
  t.write('\x1b]777;precmd\x1b\\');
  expect(t.notifyCount).toBe(0);
});

test('OSC 99 (kitty): complete single frame fires, default payload is title', () => {
  const t = new TerminalEmulator(80, 24);
  // No d= key means done (d defaults to 1); no p= means the payload is a title.
  t.write('\x1b]99;i=1;Claude needs your input\x1b\\');
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify).toEqual({ title: 'Claude needs your input', body: '' });
});

test('OSC 99 with empty metadata still fires', () => {
  const t = new TerminalEmulator(80, 24);
  t.write('\x1b]99;;just a title\x1b\\');
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify.title).toBe('just a title');
});

test('OSC 99 chunked (d=0 …then d=1): fires once, assembles title + body', () => {
  const t = new TerminalEmulator(80, 24);
  // d=0 = more chunks coming -> must NOT fire yet.
  t.write('\x1b]99;i=7:d=0;My Title\x1b\\');
  expect(t.notifyCount).toBe(0);
  // Final chunk (d defaults to done) switches payload to body -> fires once.
  t.write('\x1b]99;i=7:p=body;the body text\x1b\\');
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify).toEqual({ title: 'My Title', body: 'the body text' });
});

test('OSC 99 base64-encoded payload (e=1) is decoded', () => {
  const t = new TerminalEmulator(80, 24);
  const b64 = Buffer.from('héllo', 'utf8').toString('base64');
  t.write(`\x1b]99;i=1:e=1;${b64}\x1b\\`);
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify.title).toBe('héllo');
});

test('OSC 99 close/other payload types do not raise a notification', () => {
  const t = new TerminalEmulator(80, 24);
  t.write('\x1b]99;i=1:p=close;\x1b\\');
  expect(t.notifyCount).toBe(0);
});

test('reset() clears notification state', () => {
  const t = new TerminalEmulator(80, 24);
  t.write('\x1b]9;x\x07');
  t.reset();
  expect(t.notifyCount).toBe(0);
  expect(t.lastNotify).toEqual({ title: '', body: '' });
});

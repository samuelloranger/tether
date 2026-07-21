// Run: bun test  (from apps/mobile)  — or: bun run src/terminal.test.ts

import { APP_THEMES } from './appTheme';
import { computeLinkSpans, splitRunByLinks, urlColumns } from './links';
import { setTheme, TerminalEmulator } from './terminal';

const E = '\x1b';
function line(t: TerminalEmulator, i: number): string {
  return t
    .getSnapshot()
    [i].runs.map((r) => r.text)
    .join('')
    .replace(/\s+$/, '');
}
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

let pass = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${msg}\n  expected ${b}\n  got      ${a}`);
  pass++;
}

setTheme(APP_THEMES.mocha.terminal);

// 1. Plain text
{
  const t = new TerminalEmulator(80, 24);
  t.write('hello');
  eq(line(t, 0), 'hello', 'plain text');
}

// 2. Cursor addressing overwrites in place (the bug from the screenshot)
{
  const t = new TerminalEmulator(80, 24);
  t.write(`abc${E}[3Dxyz`); // write abc, cursor back 3, overwrite with xyz
  eq(line(t, 0), 'xyz', 'cursor back + overwrite');
}

// 3. Column positioning (CSI G) — status-line style
{
  const t = new TerminalEmulator(80, 24);
  t.write(`${E}[1Gserver${E}[1G${E}[10Gmain`);
  eq(line(t, 0), 'server   main', 'absolute column moves');
}

// 4. Repaint via cursor-up does NOT stack (the core failure we set out to fix)
{
  const t = new TerminalEmulator(80, 5);
  t.write('line1\r\nstatus: 0%');
  t.write(`\r${E}[1A`); // wait, go up to line1? no — test in-place status repaint
  const t2 = new TerminalEmulator(80, 5);
  t2.write('status: 0%');
  t2.write(`\r${E}[Kstatus: 50%`); // CR, erase line, repaint
  eq(line(t2, 0), 'status: 50%', 'in-place repaint erases old frame');
}

// 5. SGR styling preserved, non-SGR control dropped
{
  const t = new TerminalEmulator(80, 24);
  t.write(`${E}[?25l${E}[1mBold${E}[0m plain${E}[?25h`);
  const runs = t.getSnapshot()[0].runs;
  eq(runs[0].text, 'Bold', 'bold text');
  eq(runs[0].style.bold, true, 'bold flag');
  eq(runs[1].text.startsWith(' plain'), true, 'plain after reset');
  eq(!!runs[1].style.bold, false, 'reset cleared bold');
}

// 6. Split escape sequence across writes (PTY fragmentation)
{
  const t = new TerminalEmulator(80, 24);
  t.write(`x${E}[`);
  t.write('31mR');
  const runs = t.getSnapshot()[0].runs;
  eq(runs.find((r) => r.text === 'R')?.style.fg, '#f38ba8', 'split SGR sequence');
}

// 7. Newline scroll pushes to scrollback, screen keeps last N rows
{
  const t = new TerminalEmulator(80, 3);
  t.write('a\r\nb\r\nc\r\nd'); // 4 lines into a 3-row screen
  eq(screenText(t), 'a\nb\nc\nd', 'scrollback retains scrolled lines');
}

// 8. Erase display (2J) clears the screen
{
  const t = new TerminalEmulator(80, 3);
  t.write(`junk${E}[2J${E}[Hclean`);
  eq(line(t, t.getSnapshot().length - 3), 'clean', '2J clears + home');
}

// 9. Line wrap at column boundary
{
  const t = new TerminalEmulator(3, 4);
  t.write('abcdef');
  eq(line(t, 0), 'abc', 'wrap row 0');
  eq(line(t, 1), 'def', 'wrap row 1');
}

// 10. Alternate screen buffer save/restore
{
  const t = new TerminalEmulator(80, 3);
  t.write('normal');
  t.write(`${E}[?1049h`); // enter alt
  t.write('ALT');
  t.write(`${E}[?1049l`); // exit alt -> normal restored
  eq(line(t, t.getSnapshot().length - 3), 'normal', 'alt screen restores normal');
}

// 11. Truecolor + 256-color SGR
{
  const t = new TerminalEmulator(80, 24);
  t.write(`${E}[38;2;10;20;30mTC${E}[0m${E}[38;5;196mIDX`);
  const runs = t.getSnapshot()[0].runs;
  eq(runs.find((r) => r.text === 'TC')?.style.fg, '#0a141e', 'truecolor 38;2;r;g;b');
  eq(runs.find((r) => r.text === 'IDX')?.style.fg, '#ff0000', '256-color 38;5;196');
}

// 12. Dim + strikethrough SGR
{
  const t = new TerminalEmulator(80, 24);
  t.write(`${E}[2mDim${E}[22m${E}[9mStrike${E}[29mPlain`);
  const runs = t.getSnapshot()[0].runs;
  eq(runs.find((r) => r.text === 'Dim')?.style.dim, true, 'dim flag');
  eq(!!runs.find((r) => r.text === 'Strike')?.style.dim, false, '22 clears dim');
  eq(runs.find((r) => r.text === 'Strike')?.style.strike, true, 'strike flag');
  eq(!!runs.find((r) => r.text === 'Plain')?.style.strike, false, '29 clears strike');
}

// 13. DSR cursor position report replies over onReply
{
  const t = new TerminalEmulator(80, 24);
  let reply = '';
  t.onReply = (data) => {
    reply = data;
  };
  t.write(`line1\r\nabc${E}[6n`); // cursor at row 1 (0-based), col 3
  eq(reply, `${E}[2;4R`, 'DSR cursor position report');
}

// 14. Primary DA replies over onReply
{
  const t = new TerminalEmulator(80, 24);
  let reply = '';
  t.onReply = (data) => {
    reply = data;
  };
  t.write(`${E}[c`);
  eq(reply, `${E}[?1;2c`, 'primary DA reply');
}

// 15. Bracketed paste mode tracked (?2004h/l)
{
  const t = new TerminalEmulator(80, 24);
  eq(t.bracketedPaste, false, 'bracketed paste off by default');
  t.write(`${E}[?2004h`);
  eq(t.bracketedPaste, true, 'bracketed paste enabled');
  t.write(`${E}[?2004l`);
  eq(t.bracketedPaste, false, 'bracketed paste disabled');
}

// 16. Wide chars (CJK/emoji) occupy two cells
{
  const t = new TerminalEmulator(10, 4);
  let reply = '';
  t.onReply = (d) => {
    reply = d;
  };
  t.write(`你好${E}[6n`); // 2 wide chars -> cursor col 5 (1-based)
  eq(line(t, 0), '你好', 'CJK text renders');
  eq(reply, `${E}[1;5R`, 'wide chars advance cursor by 2');
}

// 17. Wide char wraps instead of splitting at the right edge
{
  const t = new TerminalEmulator(4, 3);
  t.write('abc你'); // cx=3, width-2 char cannot fit in col 3 -> wraps
  eq(line(t, 0), 'abc', 'row 0 keeps narrow chars');
  eq(line(t, 1), '你', 'wide char wrapped whole to row 1');
}

// 18. Overwriting narrow-over-wide keeps column alignment
{
  const t = new TerminalEmulator(10, 4);
  t.write(`你${E}[1;1HX`); // overwrite first half of the wide char
  const row = line(t, 0);
  eq(row.startsWith('X'), true, 'narrow overwrite lands at col 1');
}

// 19. DEC special graphics: ESC(0 maps jklmnqtuvwx to box glyphs, ESC(B restores
{
  const t = new TerminalEmulator(20, 4);
  t.write(`${E}(0lqk${E}(B done`);
  eq(line(t, 0), '┌─┐ done', 'DEC line-drawing on G0');
}

// 20. SO/SI shift between G0 and a DEC G1
{
  const t = new TerminalEmulator(20, 4);
  t.write(`${E})0plain\x0eq\x0fplain`); // designate G1=dec, SO, draw, SI
  eq(line(t, 0), 'plain─plain', 'SO selects DEC G1, SI restores G0');
}

// 21. Row shrink keeps the bottom (prompt) lines, moving top lines to scrollback
{
  const t = new TerminalEmulator(80, 5);
  t.write('one\r\ntwo\r\nthree\r\nfour\r\nprompt$');
  t.resize(80, 3);
  eq(screenText(t), 'one\ntwo\nthree\nfour\nprompt$', 'shrink loses nothing overall');
  // cursor must still sit on the prompt line: overwrite check
  t.write(' X');
  eq(screenText(t).endsWith('prompt$ X'), true, 'cursor tracked to the prompt after shrink');
}

// 22. Row grow pulls lines back out of scrollback
{
  const t = new TerminalEmulator(80, 3);
  t.write('a\r\nb\r\nc\r\nd\r\ne'); // rows a,b in scrollback; c,d,e on screen
  t.resize(80, 5);
  eq(screenText(t), 'a\nb\nc\nd\ne', 'grow restores scrollback rows to screen');
  t.write('!');
  eq(screenText(t).endsWith('e!'), true, 'cursor tracked after grow');
}

// --- Private-prefixed / lookalike CSI sequences (kitty keyboard protocol, XTMODKEYS) ---

// 23. Plain CSI s / CSI u still save and restore the cursor
{
  const t = new TerminalEmulator(20, 5);
  t.write(`${E}[2;3H${E}[s`); // move to row 2 col 3 (0-based row 1 col 2), save
  t.write(`${E}[5;1H`); // wander away
  t.write(`${E}[uX`); // restore + probe
  eq(line(t, 1), '  X', 'CSI u restores the saved cursor');
}

// 24. CSI < u (kitty keyboard pop) does NOT restore the cursor
{
  const t = new TerminalEmulator(20, 5);
  t.write(`${E}[4;1H${E}[<uX`); // cursor row 4, kitty pop must be a no-op
  eq(line(t, 3), 'X', 'CSI < u leaves the cursor in place');
  eq(line(t, 0), '', 'CSI < u did not teleport to the origin');
}

// 25. CSI > 1 u (kitty keyboard push) does NOT restore the cursor
{
  const t = new TerminalEmulator(20, 5);
  t.write(`${E}[4;1H${E}[>1uX`);
  eq(line(t, 3), 'X', 'CSI > 1 u leaves the cursor in place');
}

// 26. CSI ? u (kitty keyboard query) does NOT restore the cursor
{
  const t = new TerminalEmulator(20, 5);
  t.write(`${E}[4;1H${E}[?uX`);
  eq(line(t, 3), 'X', 'CSI ? u leaves the cursor in place');
}

// 27. CSI ? s (XTSAVE) does NOT overwrite the saved cursor
{
  const t = new TerminalEmulator(20, 5);
  t.write(`${E}[2;3H${E}[s`); // save at row 2
  t.write(`${E}[5;1H${E}[?1s`); // XTSAVE private mode — must not re-save here
  t.write(`${E}[uX`);
  eq(line(t, 1), '  X', 'CSI ? s does not overwrite the saved cursor');
}

// 28. CSI > 4 m (XTMODKEYS) does NOT reset SGR attributes
{
  const t = new TerminalEmulator(20, 5);
  t.write(`${E}[1m${E}[>4mX`); // bold on, then XTMODKEYS — pen must be untouched
  const xRun = t.getSnapshot()[0].runs.find((r) => r.text.includes('X'));
  eq(xRun?.style.bold, true, 'CSI > 4 m does not reset SGR');
}

// 29. CSI with an intermediate byte is ignored, not misdispatched
{
  const t = new TerminalEmulator(20, 5);
  // CSI 2 SP A is xterm scroll-right; without the guard it misfires as cursor-up-2.
  t.write(`${E}[4;1H${E}[2 AX`);
  eq(line(t, 3), 'X', 'CSI with intermediate byte is ignored');
}

// 30. DECSCUSR (CSI Ps SP q) is ignored
{
  const t = new TerminalEmulator(20, 5);
  t.write(`${E}[4;1H${E}[6 qX`); // vim sets cursor style with this
  eq(line(t, 3), 'X', 'DECSCUSR is ignored');
}

// 31. Tertiary DA (CSI = c) is silent; primary and secondary still reply
{
  const t = new TerminalEmulator(20, 5);
  const replies: string[] = [];
  t.onReply = (d) => replies.push(d);
  t.write(`${E}[=c`);
  eq(replies, [], 'tertiary DA (CSI = c) gets no reply');
  t.write(`${E}[c`);
  eq(replies, [`${E}[?1;2c`], 'primary DA still replies');
  t.write(`${E}[>c`);
  eq(replies, [`${E}[?1;2c`, `${E}[>0;0;0c`], 'secondary DA still replies');
}

// 32. ESC D (IND) scrolls like a line feed at the bottom margin
{
  const t = new TerminalEmulator(20, 3);
  t.write('one\r\ntwo\r\nthree'); // cursor on the bottom row after "three"
  t.write(`${E}D`); // IND at the bottom -> scroll up one line
  t.write('X');
  eq(screenText(t).endsWith('X'), true, 'IND scrolls and advances the row');
  eq(screenText(t).includes('one'), true, 'IND pushed the top line to scrollback');
}

// 33. ESC E (NEL) moves to the next line, column 0
{
  const t = new TerminalEmulator(20, 3);
  t.write(`abc${E}EX`);
  eq(line(t, 1), 'X', 'NEL moves to the next line, column 0');
}

// 34. Claude exit tail: the prompt lands below the last frame, not mid-screen
{
  const t = new TerminalEmulator(40, 10);
  // Minimal reconstruction of the observed exit stream: UI box on rows 6-7,
  // cursor parked below it, then the real exit sequence claude emits.
  t.write(`${E}[7;1H> input box\r\n exit hint\r\n`);
  t.write(`${E}(B${E}[>4m${E}[<u${E}[?2004l${E}[?25h${E}7${E}[r${E}8`);
  t.write('user@host ~> ');
  eq(line(t, 8).includes('user@host'), true, 'prompt lands directly below the frame');
  eq(line(t, 0).includes('user@host'), false, 'exit did not teleport the prompt to the top');
}

// 35. Private DSR (CSI > Ps n / CSI ? Ps n) does NOT emit a cursor report
{
  const t = new TerminalEmulator(80, 24);
  const replies: string[] = [];
  t.onReply = (d) => replies.push(d);
  t.write(`${E}[>6n`); // key-modifier control — must not reply
  eq(replies, [], 'CSI > 6 n emits no reply');
  t.write(`${E}[?6n`); // DEC DSR — must not reply
  eq(replies, [], 'CSI ? 6 n emits no reply');
  t.write(`line1\r\nabc${E}[6n`); // plain DSR still replies
  eq(replies, [`${E}[2;4R`], 'plain CSI 6 n still reports the cursor');
}

// 36. Autowrap marks the leaving row as soft-wrapped; explicit newline does not
{
  const t = new TerminalEmulator(20, 5);
  t.write('https://example.com/abcdefghij'); // 30 chars into a 20-col screen
  const snap = t.getSnapshot();
  eq(snap[0].wrapped, true, 'row that overflowed is soft-wrapped');
  eq(snap[1].wrapped, false, 'continuation row is not itself wrapped');
}

// 37. Hard newline is not a soft-wrap
{
  const t = new TerminalEmulator(40, 5);
  t.write('short\r\nnext');
  eq(t.getSnapshot()[0].wrapped, false, 'row ended by \\n is not soft-wrapped');
}

// 38. computeLinkSpans reconstructs a URL split across a soft-wrap
{
  const url = 'https://example.com/abcdefghij';
  const rows = [url.slice(0, 20), url.slice(20)]; // as the 20-col grid would split it
  const spans = computeLinkSpans(rows, [true, false]);
  eq(
    spans[0],
    [{ start: 0, end: 20, target: { kind: 'external', url } }],
    'first fragment carries the full URL',
  );
  eq(
    spans[1],
    [{ start: 0, end: 10, target: { kind: 'external', url } }],
    'second fragment carries the full URL',
  );
}

// 39. Hard-newline'd lines are not joined into one link
{
  const spans = computeLinkSpans(['http://a.com', 'http://b.com'], [false, false]);
  eq(
    spans[0],
    [{ start: 0, end: 12, target: { kind: 'external', url: 'http://a.com' } }],
    'line A its own link',
  );
  eq(
    spans[1],
    [{ start: 0, end: 12, target: { kind: 'external', url: 'http://b.com' } }],
    'line B its own link',
  );
}

// 40. A URL wrapping across three rows resolves whole on every fragment
{
  const url = 'https://example.com/' + 'x'.repeat(25); // 45 chars
  const rows = [url.slice(0, 20), url.slice(20, 40), url.slice(40)];
  const spans = computeLinkSpans(rows, [true, true, false]);
  eq(spans[0][0].target, { kind: 'external', url }, 'row 0 fragment -> full URL');
  eq(spans[1][0].target, { kind: 'external', url }, 'row 1 fragment -> full URL');
  eq(spans[2][0].target, { kind: 'external', url }, 'row 2 fragment -> full URL');
}

// 41. End-to-end: emulator autowrap + computeLinkSpans give one full URL
{
  const url = 'https://example.com/abcdefghij';
  const t = new TerminalEmulator(20, 5);
  t.write(url);
  const snap = t.getSnapshot();
  const texts = snap.map((r) => r.runs.map((x) => x.text).join(''));
  const spans = computeLinkSpans(
    texts,
    snap.map((r) => r.wrapped),
  );
  eq(spans[0][0]?.target, { kind: 'external', url }, 'row 0 resolves the full wrapped URL');
  eq(spans[1][0]?.target, { kind: 'external', url }, 'row 1 resolves the full wrapped URL');
}

// 42. splitRunByLinks isolates the link portion of a run, tagging it with the target
{
  const url = 'http://x.io';
  const spans = computeLinkSpans([`see ${url} now`], [false]);
  const urlAt = urlColumns(spans[0]);
  const segs = splitRunByLinks(`see ${url} now`, 0, urlAt);
  eq(
    segs,
    [{ text: 'see ' }, { text: url, target: { kind: 'external', url } }, { text: ' now' }],
    'link split out with target',
  );
}

// 43. splitRunByLinks respects a run's column offset within the row
{
  const url = 'http://x.io';
  // Row text is 'ab' + url; the link occupies columns 2..12. A run starting at
  // column 2 should surface the whole URL as one tagged segment.
  const urlAt = urlColumns(computeLinkSpans([`ab${url}`], [false])[0]);
  eq(
    splitRunByLinks(url, 2, urlAt),
    [{ text: url, target: { kind: 'external', url } }],
    'offset run maps to the target',
  );
}

// 44. Bell increments a counter instead of being dropped
{
  const t = new TerminalEmulator(80, 24);
  eq(t.bellCount, 0, 'bell starts at 0');
  t.write('\x07');
  eq(t.bellCount, 1, 'bell increments on BEL');
  t.write('a\x07b\x07');
  eq(t.bellCount, 3, 'bell increments once per BEL byte');
}

// 45. OSC 0/2 sets the window title
{
  const t = new TerminalEmulator(80, 24);
  eq(t.title, '', 'title starts empty');
  t.write(`${E}]2;my-session${E}\\`);
  eq(t.title, 'my-session', 'OSC 2 sets title (ST terminator)');
  t.write(`${E}]0;another\x07`);
  eq(t.title, 'another', 'OSC 0 sets title (BEL terminator)');
}

// 46. OSC 7 sets cwd from a file:// URI, stripping host + decoding percent-escapes
{
  const t = new TerminalEmulator(80, 24);
  eq(t.cwd, '', 'cwd starts empty');
  t.write(`${E}]7;file://myhost/home/sam/My%20Project${E}\\`);
  eq(t.cwd, '/home/sam/My Project', 'OSC 7 parses path, strips host, decodes %20');
}

// 46a. A malformed OSC 7 escape keeps the parser live and preserves the raw path.
{
  const t = new TerminalEmulator(80, 24);
  t.write(`${E}]7;file://myhost/home/sam/foo%bar${E}\\after`);
  eq(t.cwd, '/home/sam/foo%bar', 'malformed OSC 7 path is kept raw');
  eq(line(t, 0), 'after', 'parser resumes after malformed OSC 7');
}

// 47. DECSCUSR sets cursor shape/blink
{
  const t = new TerminalEmulator(80, 24);
  eq(t.cursorStyle, 'block', 'default cursor shape is block');
  eq(t.cursorBlink, true, 'default cursor blinks');
  t.write(`${E}[5 q`);
  eq(t.cursorStyle, 'bar', 'Ps=5 -> blinking bar');
  eq(t.cursorBlink, true, 'Ps=5 -> blink on');
  t.write(`${E}[4 q`);
  eq(t.cursorStyle, 'underline', 'Ps=4 -> steady underline');
  eq(t.cursorBlink, false, 'Ps=4 -> blink off (even Ps = steady)');
  t.write(`${E}[2 q`);
  eq(t.cursorStyle, 'block', 'Ps=2 -> steady block');
}

// 48. OSC 133 marks prompt-start rows for jump navigation
{
  const t = new TerminalEmulator(80, 24);
  t.write(`${E}]133;A${E}\\$ ls\r\n`); // row 0: prompt + echoed command (same row, no newline in between)
  t.write('file.txt\r\n'); // row 1: command output
  t.write(`${E}]133;A${E}\\$ `); // row 2: next prompt
  const rows = t.getSnapshot();
  eq(rows[0].promptStart, true, 'row 0 is a prompt row');
  eq(rows[1].promptStart, false, 'row 1 is not a prompt row');
  eq(rows[2].promptStart, true, 'row 2 is a prompt row');
  eq(t.jumpToPrompt(2, -1), 0, 'jump backward from row 2 finds row 0');
  eq(t.jumpToPrompt(0, 1), 2, 'jump forward from row 0 finds row 2');
  eq(t.jumpToPrompt(0, -1), null, 'jump backward from the first prompt finds nothing');
}

// 49. OSC 8 hyperlinks: explicit spans win over regex reconstruction
{
  const t = new TerminalEmulator(80, 24);
  t.write(`click ${E}]8;;https://example.com${E}\\here${E}]8;;${E}\\ done`);
  const links = t.getSnapshot()[0].links;
  eq(links.length, 1, 'exactly one link span on the row');
  eq(
    links[0].target,
    { kind: 'external', url: 'https://example.com' },
    'link carries the OSC 8 URI',
  );
  // "click " (0-5) is not part of the link; "here" (6-9) is (starts after "click ").
  eq(links[0].start, 6, 'link starts at "here"');
  eq(links[0].end, 10, 'link ends after "here"');
}

// 50. Plain (non-OSC-8) URLs still fall back to regex detection
{
  const t = new TerminalEmulator(80, 24);
  t.write('see https://example.com/path for details');
  const links = t.getSnapshot()[0].links;
  eq(links.length, 1, 'regex still finds a plain URL');
  eq(
    links[0].target,
    { kind: 'external', url: 'https://example.com/path' },
    'regex-detected URL is correct',
  );
}

// 51. setTheme swaps the ANSI palette + default fg/bg used by new writes
{
  const t = new TerminalEmulator(80, 24);
  setTheme({ base16: Array(16).fill('#111111'), fg: '#eeeeee', bg: '#000000' });
  t.write(`${E}[31mred${E}[0m`);
  eq(t.getSnapshot()[0].runs[0].style.fg, '#111111', 'SGR 31 resolves through the new base16');
  setTheme(APP_THEMES.latte.terminal);
  const latte = new TerminalEmulator(80, 24);
  latte.write(`plain ${E}[31mred`);
  const runs = latte.getSnapshot()[0].runs;
  eq(runs[0].style.fg, '#4c4f69', 'Latte terminal foreground is semantic');
  eq(runs[1].style.fg, '#d20f39', 'Latte ANSI red is semantic');
  setTheme(APP_THEMES.mocha.terminal);
}

// 52. Existing ANSI cells repaint through the new palette after a theme switch.
{
  const t = new TerminalEmulator(80, 24);
  t.write(`${E}[31mred`);
  setTheme(APP_THEMES.latte.terminal);
  eq(t.getSnapshot()[0].runs[0].style.fg, '#d20f39', 'existing ANSI red recolors for Latte');
  setTheme(APP_THEMES.mocha.terminal);
}

// 53. Inverse ANSI cells keep their resolved palette color after a theme switch.
{
  const t = new TerminalEmulator(80, 24);
  t.write(`${E}[31;7minverse`);
  setTheme(APP_THEMES.latte.terminal);
  const style = t.getSnapshot()[0].runs[0].style;
  eq(style.fg, '#eff1f5', 'inverse foreground uses Latte terminal background');
  eq(style.bg, '#d20f39', 'inverse background uses Latte ANSI red');
  setTheme(APP_THEMES.mocha.terminal);
}

// 54. A resize (e.g. keyboard show/hide) must not orphan a wrapped row's
// wrapped-link tracking — regression for the "links survive line-break" fix.
{
  const t = new TerminalEmulator(20, 10);
  const url = 'http://example.com/some/very/long/path/that/wraps';
  t.write(url);
  t.resize(20, 6); // keyboard shows: rows shrink
  t.resize(20, 10); // keyboard hides: rows grow back
  const snap = t.getSnapshot();
  eq(snap[0].wrapped, true, 'row 0 still marked soft-wrapped after a resize round trip');
  eq(
    snap[0].links[0]?.target,
    { kind: 'external', url },
    'row 0 still resolves the full URL after a resize round trip',
  );
  eq(
    snap[1].links[0]?.target,
    { kind: 'external', url },
    'row 1 still resolves the full URL after a resize round trip',
  );
}

// 55. OSC 10 query replies with the current theme foreground as an xterm rgb: color.
{
  const t = new TerminalEmulator(80, 24);
  const replies: string[] = [];
  t.onReply = (data) => replies.push(data);
  t.write(`${E}]10;?${E}\\`);
  eq(replies.length, 1, 'OSC 10 query produced exactly one reply');
  eq(replies[0], `${E}]10;rgb:cdcd/d6d6/f4f4${E}\\`, 'OSC 10 reply carries Mocha fg as rgb:');
}

// 56. OSC 11 query replies with the current theme background; non-query OSC 10/11 is a no-op.
{
  const t = new TerminalEmulator(80, 24);
  const replies: string[] = [];
  t.onReply = (data) => replies.push(data);
  t.write(`${E}]11;?${E}\\`);
  eq(replies.length, 1, 'OSC 11 query produced exactly one reply');
  eq(replies[0], `${E}]11;rgb:1e1e/1e1e/2e2e${E}\\`, 'OSC 11 reply carries Mocha bg as rgb:');
  t.write(`${E}]10;rgb:ffff/ffff/ffff${E}\\`); // "set" form — must NOT trigger a reply
  eq(replies.length, 1, 'OSC 10 set-form (non-"?") produces no reply');
}

// 57. OSC 52 write: base64 payload is decoded and handed to onClipboardWrite.
{
  const t = new TerminalEmulator(80, 24);
  const written: string[] = [];
  t.onClipboardWrite = (text) => written.push(text);
  t.write(`${E}]52;c;aGVsbG8gd29ybGQ=${E}\\`); // base64("hello world")
  eq(written, ['hello world'], 'OSC 52 write decodes base64 to onClipboardWrite');
}

// 58. OSC 52 write: non-ASCII text round-trips correctly (UTF-8 safe base64).
{
  const t = new TerminalEmulator(80, 24);
  const written: string[] = [];
  t.onClipboardWrite = (text) => written.push(text);
  t.write(`${E}]52;c;44GT44KT44Gr44Gh44Gv${E}\\`); // base64("こんにちは")
  eq(written, ['こんにちは'], 'OSC 52 write decodes multi-byte UTF-8 base64 correctly');
}

// 59. OSC 52 query ("?") is intentionally unsupported — no onReply, no read of
// the device clipboard. Supporting it would let any process in the shell
// silently exfiltrate the clipboard with no user consent.
{
  const t = new TerminalEmulator(80, 24);
  const replies: string[] = [];
  const written: string[] = [];
  t.onReply = (data) => replies.push(data);
  t.onClipboardWrite = (text) => written.push(text);
  t.write(`${E}]52;c;?${E}\\`);
  eq(replies, [], 'OSC 52 query produces no reply');
  eq(written, [], 'OSC 52 query does not call onClipboardWrite');
}

// 60. OSC 52 write: empty payload is the valid "clear the clipboard" form.
{
  const t = new TerminalEmulator(80, 24);
  const written: string[] = [];
  t.onClipboardWrite = (text) => written.push(text);
  t.write(`${E}]52;c;${E}\\`);
  eq(written, [''], "OSC 52 empty payload clears the clipboard via onClipboardWrite('')");
}

// 61. OSC 52 write: malformed base64 fails silently — no throw, no onClipboardWrite call.
{
  const t = new TerminalEmulator(80, 24);
  const written: string[] = [];
  t.onClipboardWrite = (text) => written.push(text);
  t.write(`${E}]52;c;not-valid-base64!!!${E}\\`);
  eq(written, [], 'malformed OSC 52 base64 does not call onClipboardWrite');
}

// 62. promptReturnCount increments once per OSC 133;A (new shell prompt = previous command finished).
{
  const t = new TerminalEmulator(80, 24);
  eq(t.promptReturnCount, 0, 'promptReturnCount starts at 0');
  t.write(`${E}]133;A${E}\\`);
  eq(t.promptReturnCount, 1, 'promptReturnCount increments on OSC 133;A');
  t.write(`ls${E}]133;D;0${E}\\${E}]133;A${E}\\`);
  eq(
    t.promptReturnCount,
    2,
    'promptReturnCount increments once per new prompt, not per OSC 133 sequence',
  );
}

// 63. BCE: erase fills carry the pen's background so cleared areas paint.
{
  const t = new TerminalEmulator(10, 4);
  t.write(`${E}[44m`); // blue bg pen
  t.write(`${E}[2J`); // full clear with colored pen
  const row = t.getSnapshot()[1];
  eq(row.runs.length >= 1 && !!row.runs[0].style.bg, true, 'BCE: ED2 fill has pen bg');
  const t2 = new TerminalEmulator(10, 4);
  t2.write('hi');
  t2.write(`${E}[2J`); // clear with DEFAULT pen — no bg painted
  const row2 = t2.getSnapshot()[0];
  eq(row2.runs.map((r) => !!r.style.bg).includes(true), false, 'BCE: default-pen ED2 stays unstyled');
  const t3 = new TerminalEmulator(10, 4);
  t3.write(`abc${E}[41m${E}[K`); // EL0 with red bg from cursor to EOL
  const r3 = t3.getSnapshot()[0];
  eq(!!r3.runs[r3.runs.length - 1].style.bg, true, 'BCE: EL0 fill has pen bg');
}

// 64. RenderRow.key is stable while lines shift into scrollback.
{
  const t = new TerminalEmulator(10, 3);
  t.write('one\r\ntwo\r\nthree');
  const before = t.getSnapshot();
  const keyOfTwo = before.find((r) => r.runs.map((x) => x.text).join('').startsWith('two'))!.key;
  t.write('\r\nfour\r\nfive'); // pushes rows into scrollback
  const after = t.getSnapshot();
  const twoRow = after.find((r) => r.runs.map((x) => x.text).join('').startsWith('two'))!;
  eq(twoRow.key, keyOfTwo, 'row key survives move into scrollback');
  const keys = after.map((r) => r.key);
  eq(new Set(keys).size, keys.length, 'row keys are unique');
}

// 65. Scrollback reflows when the width changes.
{
  const t = new TerminalEmulator(10, 2);
  // 'abcdefghijKLMno' wraps at 10 cols → 'abcdefghij' + 'KLMno' (soft wrap).
  t.write('abcdefghijKLMno\r\n');
  t.write('x\r\ny\r\nz'); // push the wrapped pair fully into scrollback
  const narrow = t
    .getSnapshot()
    .map((r) => r.runs.map((x) => x.text).join('').replace(/\s+$/, ''));
  eq(narrow[0], 'abcdefghij', 'pre-reflow first fragment');
  t.resize(20, 2);
  const wide = t
    .getSnapshot()
    .map((r) => r.runs.map((x) => x.text).join('').replace(/\s+$/, ''));
  eq(wide[0], 'abcdefghijKLMno', 'reflow joins soft-wrapped history at the new width');
  t.resize(6, 2);
  const tight = t
    .getSnapshot()
    .map((r) => r.runs.map((x) => x.text).join('').replace(/\s+$/, ''));
  eq(tight.slice(0, 3), ['abcdef', 'ghijKL', 'Mno'], 'reflow re-splits history when narrowed');
}

// 66. Combined cols+rows resize (rotation): rows pushed into scrollback by the
// shrink are rewrapped at the new width too.
{
  const t = new TerminalEmulator(10, 4);
  t.write('abcdefghijKLMno\r\nx'); // wrapped pair on rows 0-1, cursor line 'x' on row 2
  t.resize(20, 2); // widen + shrink rows in ONE call
  const rows = t
    .getSnapshot()
    .map((r) => r.runs.map((x) => x.text).join('').replace(/\s+$/, ''));
  eq(rows[0], 'abcdefghijKLMno', 'combined resize reflows rows the shrink pushed to scrollback');
}

console.log(`\n  ${pass} assertions passed\n`);

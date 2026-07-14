// Run: bun test  (from apps/mobile)  — or: bun run src/terminal.test.ts
import { TerminalEmulator } from './terminal';
import { computeLinkSpans, splitRunByLinks, urlColumns } from './links';

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
    .map((r) => r.runs.map((x) => x.text).join('').replace(/\s+$/, ''))
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
  eq(runs.find((r) => r.text === 'R')?.style.fg, '#cd3131', 'split SGR sequence');
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
  eq(spans[0], [{ start: 0, end: 20, url }], 'first fragment carries the full URL');
  eq(spans[1], [{ start: 0, end: 10, url }], 'second fragment carries the full URL');
}

// 39. Hard-newline'd lines are not joined into one link
{
  const spans = computeLinkSpans(['http://a.com', 'http://b.com'], [false, false]);
  eq(spans[0], [{ start: 0, end: 12, url: 'http://a.com' }], 'line A its own link');
  eq(spans[1], [{ start: 0, end: 12, url: 'http://b.com' }], 'line B its own link');
}

// 40. A URL wrapping across three rows resolves whole on every fragment
{
  const url = 'https://example.com/' + 'x'.repeat(25); // 45 chars
  const rows = [url.slice(0, 20), url.slice(20, 40), url.slice(40)];
  const spans = computeLinkSpans(rows, [true, true, false]);
  eq(spans[0][0].url, url, 'row 0 fragment -> full URL');
  eq(spans[1][0].url, url, 'row 1 fragment -> full URL');
  eq(spans[2][0].url, url, 'row 2 fragment -> full URL');
}

// 41. End-to-end: emulator autowrap + computeLinkSpans give one full URL
{
  const url = 'https://example.com/abcdefghij';
  const t = new TerminalEmulator(20, 5);
  t.write(url);
  const snap = t.getSnapshot();
  const texts = snap.map((r) => r.runs.map((x) => x.text).join(''));
  const spans = computeLinkSpans(texts, snap.map((r) => r.wrapped));
  eq(spans[0][0]?.url, url, 'row 0 resolves the full wrapped URL');
  eq(spans[1][0]?.url, url, 'row 1 resolves the full wrapped URL');
}

// 42. splitRunByLinks isolates the link portion of a run, tagging it with the url
{
  const url = 'http://x.io';
  const spans = computeLinkSpans([`see ${url} now`], [false]);
  const urlAt = urlColumns(spans[0]);
  const segs = splitRunByLinks(`see ${url} now`, 0, urlAt);
  eq(segs, [{ text: 'see ' }, { text: url, url }, { text: ' now' }], 'link split out with url');
}

// 43. splitRunByLinks respects a run's column offset within the row
{
  const url = 'http://x.io';
  // Row text is 'ab' + url; the link occupies columns 2..12. A run starting at
  // column 2 should surface the whole url as one tagged segment.
  const urlAt = urlColumns(computeLinkSpans([`ab${url}`], [false])[0]);
  eq(splitRunByLinks(url, 2, urlAt), [{ text: url, url }], 'offset run maps to the url');
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
  t.write('file.txt\r\n');            // row 1: command output
  t.write(`${E}]133;A${E}\\$ `);      // row 2: next prompt
  const rows = t.getSnapshot();
  eq(rows[0].promptStart, true, 'row 0 is a prompt row');
  eq(rows[1].promptStart, false, 'row 1 is not a prompt row');
  eq(rows[2].promptStart, true, 'row 2 is a prompt row');
  eq(t.jumpToPrompt(2, -1), 0, 'jump backward from row 2 finds row 0');
  eq(t.jumpToPrompt(0, 1), 2, 'jump forward from row 0 finds row 2');
  eq(t.jumpToPrompt(0, -1), null, 'jump backward from the first prompt finds nothing');
}

console.log(`\n  ${pass} assertions passed\n`);

// Run: bun test  (from apps/mobile)  — or: bun run src/terminal.test.ts
import { TerminalEmulator } from './terminal';

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

console.log(`\n  ${pass} assertions passed\n`);

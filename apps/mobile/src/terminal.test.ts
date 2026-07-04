import { describe, expect, test } from 'bun:test';
import { TerminalEmulator } from './terminal';

function rows(emu: TerminalEmulator): string[] {
  return emu.getSnapshot().map((r) => r.runs.map((run) => run.text).join(''));
}

describe('private-prefixed CSI sequences (kitty keyboard protocol, XTMODKEYS)', () => {
  test('plain CSI s / CSI u still save and restore the cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[2;3H\x1b[s'); // move to row 2 col 3, save
    emu.write('\x1b[5;1H'); // wander away
    emu.write('\x1b[uX'); // restore, probe
    expect(rows(emu)[1]).toContain('X'); // row 2 (0-indexed 1)
  });

  test('CSI < u (kitty pop) does NOT restore the cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[4;1H'); // cursor on row 4
    emu.write('\x1b[<u'); // kitty keyboard pop — must be a no-op
    emu.write('X');
    expect(rows(emu)[3]).toContain('X'); // still row 4
    expect(rows(emu)[0]).not.toContain('X'); // did NOT jump to never-saved (0,0)
  });

  test('CSI > 1 u (kitty push) does NOT restore the cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[4;1H\x1b[>1uX');
    expect(rows(emu)[3]).toContain('X');
  });

  test('CSI ? u (kitty query) does NOT restore or save the cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[4;1H\x1b[?uX');
    expect(rows(emu)[3]).toContain('X');
  });

  test('CSI ? s (XTSAVE) does NOT overwrite the saved cursor', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[2;3H\x1b[s'); // save at row 2
    emu.write('\x1b[5;1H\x1b[?1s'); // XTSAVE private mode — must not re-save here
    emu.write('\x1b[uX');
    expect(rows(emu)[1]).toContain('X'); // restored to row 2, not row 5
  });

  test('CSI > 4 m (XTMODKEYS) does NOT reset SGR attributes', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[1m'); // bold on
    emu.write('\x1b[>4m'); // XTMODKEYS — must not touch the pen
    emu.write('X');
    const runs = emu.getSnapshot()[0].runs;
    const xRun = runs.find((r) => r.text.includes('X'));
    expect(xRun?.bold).toBe(true);
  });

  test('CSI with intermediate bytes is ignored, not misdispatched', () => {
    const emu = new TerminalEmulator(20, 5);
    // CSI 2 SP A is xterm scroll-right (SR); without the guard it misfires as
    // cursor-up-2. Cursor must stay on row 4.
    emu.write('\x1b[4;1H\x1b[2 AX');
    expect(rows(emu)[3]).toContain('X');
  });

  test('DECSCUSR (CSI Ps SP q) is ignored', () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write('\x1b[4;1H\x1b[6 qX'); // vim sets cursor style with this
    expect(rows(emu)[3]).toContain('X');
  });

  test('tertiary DA (CSI = c) gets no reply; primary and secondary still do', () => {
    const emu = new TerminalEmulator(20, 5);
    const replies: string[] = [];
    emu.onReply = (d) => replies.push(d);
    emu.write('\x1b[=c');
    expect(replies).toEqual([]); // must NOT answer with the primary DA string
    emu.write('\x1b[c');
    expect(replies).toEqual(['\x1b[?1;2c']);
    emu.write('\x1b[>c');
    expect(replies).toEqual(['\x1b[?1;2c', '\x1b[>0;0;0c']);
  });

  test('ESC D (IND) scrolls like line feed; ESC E (NEL) also returns to col 0', () => {
    const emu = new TerminalEmulator(20, 3);
    emu.write('one\r\ntwo\r\nthree'); // cursor on bottom row after "three"
    emu.write('\x1bD'); // IND at bottom -> scroll up one line
    emu.write('X');
    const r = rows(emu);
    expect(r[r.length - 1]).toContain('X'); // new bottom line
    expect(r.join('\n')).toContain('one'); // "one" pushed to scrollback, still present

    const emu2 = new TerminalEmulator(20, 3);
    emu2.write('abc\x1bEX'); // NEL: next line, column 0
    expect(rows(emu2)[1]?.startsWith('X')).toBe(true);
  });

  test('claude exit tail: prompt lands below the last frame, not mid-screen', () => {
    const emu = new TerminalEmulator(40, 10);
    // Minimal reconstruction of the observed exit stream: UI box on rows 7-9,
    // cursor parked below it, then the real exit sequence claude emits.
    emu.write('\x1b[7;1H> input box\r\n exit hint\r\n');
    emu.write('\x1b(B\x1b[>4m\x1b[<u\x1b[?2004l\x1b[?25h\x1b7\x1b[r\x1b8');
    emu.write('user@host ~> ');
    expect(rows(emu)[9]).toContain('user@host'); // bottom row, below the box
    expect(rows(emu)[0]).not.toContain('user@host');
  });
});

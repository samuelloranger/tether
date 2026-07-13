import { describe, expect, it } from 'bun:test';
import { mouseSeq } from './mouseSeq';

describe('mouseSeq — SGR encoding (?1006h)', () => {
  it('encodes wheel up/down as decimal SGR press events', () => {
    expect(mouseSeq(64, 40, 12, true)).toBe('\x1b[<64;40;12M');
    expect(mouseSeq(65, 1, 1, true)).toBe('\x1b[<65;1;1M');
  });
});

describe('mouseSeq — legacy X10 encoding', () => {
  it('offsets button and coordinates by 32 into single bytes', () => {
    // btn 64 -> 96 '`', col 1 -> 33 '!', row 1 -> 33 '!'
    expect(mouseSeq(64, 1, 1, false)).toBe('\x1b[M`!!');
    // btn 65 -> 97 'a'
    expect(mouseSeq(65, 1, 1, false)).toBe('\x1b[Ma!!');
  });
  it('clamps values to a single UTF-8 byte (≤127) so wide grids do not corrupt', () => {
    const seq = mouseSeq(65, 300, 300, false);
    for (const ch of seq) expect(ch.charCodeAt(0)).toBeLessThanOrEqual(127);
    // col/row clamp to 127 (95 + 32)
    expect(seq).toBe(`\x1b[Ma${String.fromCharCode(127)}${String.fromCharCode(127)}`);
  });
});

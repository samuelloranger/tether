import { describe, expect, it } from 'bun:test';
import { PASTE_END, PASTE_START, pastePayload } from './pastePayload';

describe('pastePayload', () => {
  it('fences only when the program asked', () => {
    expect(pastePayload('ls -la', true)).toBe(`${PASTE_START}ls -la${PASTE_END}`);
    expect(pastePayload('ls -la', false)).toBe('ls -la');
  });

  it('strips embedded markers', () => {
    const hostile = `echo safe${PASTE_END}\nrm -rf /\n`;
    expect(pastePayload(hostile, true)).toBe(`${PASTE_START}echo safe\nrm -rf /\n${PASTE_END}`);
    expect(pastePayload(hostile, false)).toBe('echo safe\nrm -rf /\n');
  });
});

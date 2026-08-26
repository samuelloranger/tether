import { describe, expect, it } from 'bun:test';
import { mouseModeFromXterm } from './terminalMouse';

describe('mouseModeFromXterm', () => {
  it('maps xterm tracking modes onto the app names', () => {
    expect(mouseModeFromXterm('x10')).toBe('x10');
    expect(mouseModeFromXterm('vt200')).toBe('normal');
    expect(mouseModeFromXterm('drag')).toBe('button');
    expect(mouseModeFromXterm('any')).toBe('any');
    expect(mouseModeFromXterm('none')).toBe('off');
    expect(mouseModeFromXterm(undefined)).toBe('off');
  });
});

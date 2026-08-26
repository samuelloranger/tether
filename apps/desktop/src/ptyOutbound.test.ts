import { describe, expect, it } from 'bun:test';
import { shouldSendOutbound } from './ptyOutbound';

describe('shouldSendOutbound', () => {
  it('drops parser auto-replies only while replay is in flight', () => {
    expect(shouldSendOutbound(true, true)).toBe(false);
    expect(shouldSendOutbound(true, false)).toBe(true);
  });

  it('never drops user keystrokes or mouse reports', () => {
    expect(shouldSendOutbound(false, true)).toBe(true);
    expect(shouldSendOutbound(false, false)).toBe(true);
  });
});

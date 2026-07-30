import { describe, expect, it } from 'bun:test';
import { shouldActivateLink } from './terminalRendererLinks';

describe('shouldActivateLink', () => {
  it('opens on any click when modifier is not required (mobile)', () => {
    expect(shouldActivateLink(undefined, false)).toBe(true);
    expect(shouldActivateLink({ ctrlKey: false, metaKey: false }, false)).toBe(true);
  });
  it('requires Ctrl or Cmd when modifier is required (desktop)', () => {
    expect(shouldActivateLink({ ctrlKey: false, metaKey: false }, true)).toBe(false);
    expect(shouldActivateLink(undefined, true)).toBe(false);
    expect(shouldActivateLink({ ctrlKey: true }, true)).toBe(true);
    expect(shouldActivateLink({ metaKey: true }, true)).toBe(true);
  });
});

import { describe, expect, it } from 'bun:test';
import { rendererLinksForRow, shouldActivateLink } from './terminalLinks';

describe('shouldActivateLink', () => {
  it('requires a modifier on desktop', () => {
    expect(shouldActivateLink({}, true)).toBe(false);
    expect(shouldActivateLink({ ctrlKey: true }, true)).toBe(true);
    expect(shouldActivateLink({ metaKey: true }, true)).toBe(true);
  });

  it('maps rust spans onto 1-based xterm ranges', () => {
    const links = rendererLinksForRow(
      ['see https://example.com now'],
      [[{ start: 4, end: 23, target: { kind: 'external', url: 'https://example.com' } }]],
      0,
    );
    expect(links[0]?.range).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 23, y: 1 },
    });
    expect(links[0]?.text).toBe('https://example.com');
  });
});

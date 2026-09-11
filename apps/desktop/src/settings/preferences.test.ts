import { describe, expect, it } from 'bun:test';
import { parseTabLayout } from './preferences';

describe('parseTabLayout', () => {
  it('defaults to sidebar', () => {
    expect(parseTabLayout(null)).toBe('sidebar');
    expect(parseTabLayout('')).toBe('sidebar');
    expect(parseTabLayout('nope')).toBe('sidebar');
  });

  it('accepts horizontal', () => {
    expect(parseTabLayout('horizontal')).toBe('horizontal');
    expect(parseTabLayout('sidebar')).toBe('sidebar');
  });
});

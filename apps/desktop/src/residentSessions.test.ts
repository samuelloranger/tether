import { describe, expect, test } from 'bun:test';
import { residentSessions } from './residentSessions';

describe('residentSessions', () => {
  test('visible sessions are always resident', () => {
    const out = residentSessions({
      drawerKeys: ['h:a', 'h:b'],
      visibleKeys: ['h:a'],
      lruOrder: [],
      cap: 8,
    });
    expect(out).toContain('h:a');
  });

  test('fills remaining capacity from the LRU, most-recent first', () => {
    const out = residentSessions({
      drawerKeys: ['h:a', 'h:b', 'h:c', 'h:d'],
      visibleKeys: ['h:a'],
      lruOrder: ['h:c', 'h:b'],
      cap: 3,
    });
    expect(out).toEqual(['h:a', 'h:c', 'h:b']);
  });

  test('never exceeds the cap when filling from the LRU', () => {
    const out = residentSessions({
      drawerKeys: ['h:a', 'h:b', 'h:c'],
      visibleKeys: [],
      lruOrder: ['h:a', 'h:b', 'h:c'],
      cap: 2,
    });
    expect(out).toHaveLength(2);
  });

  test('visible sessions past the cap are all kept (never evicted)', () => {
    const out = residentSessions({
      drawerKeys: ['h:a', 'h:b', 'h:c'],
      visibleKeys: ['h:a', 'h:b', 'h:c'],
      lruOrder: [],
      cap: 2,
    });
    expect(out).toEqual(['h:a', 'h:b', 'h:c']);
  });

  test('a key absent from the drawer is never resident', () => {
    const out = residentSessions({
      drawerKeys: ['h:a'],
      visibleKeys: [],
      lruOrder: ['h:ghost', 'h:a'],
      cap: 8,
    });
    expect(out).not.toContain('h:ghost');
    expect(out).toContain('h:a');
  });
});

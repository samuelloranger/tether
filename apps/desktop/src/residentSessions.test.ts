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

  // The zero-replay oracle in pure form: across A(visible)→B(visible)→A(visible),
  // session A must stay in the resident set the whole time. Its TerminalPane is
  // keyed by session, so staying resident == the mount (and its socket) is never
  // torn down == nothing to replay on switch-back.
  test('A stays resident across A→B→A (socket never drops)', () => {
    const drawerKeys = ['h:a', 'h:b'];
    const cap = 8;
    // A visible, B in background.
    const step1 = residentSessions({ drawerKeys, visibleKeys: ['h:a'], lruOrder: ['h:a'], cap });
    // Switch to B: A is now background but recently active.
    const step2 = residentSessions({
      drawerKeys,
      visibleKeys: ['h:b'],
      lruOrder: ['h:b', 'h:a'],
      cap,
    });
    // Switch back to A.
    const step3 = residentSessions({
      drawerKeys,
      visibleKeys: ['h:a'],
      lruOrder: ['h:a', 'h:b'],
      cap,
    });
    expect(step1).toContain('h:a');
    expect(step2).toContain('h:a');
    expect(step3).toContain('h:a');
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

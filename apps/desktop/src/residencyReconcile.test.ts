import { describe, expect, test } from 'bun:test';
import { reconcileResidency } from './residencyReconcile';

describe('reconcileResidency', () => {
  test('tab switched away (still in drawer) keeps its replay cursor', () => {
    // 'a' is mounted (wanted); 'b' was switched away but is still a drawer tab.
    const plan = reconcileResidency({
      drawerKeys: ['h:a', 'h:b'],
      wantedKeys: ['h:a'],
      cachedIds: ['h:a', 'h:b'],
    });
    expect(plan.forgetCursor).not.toContain('h:b');
    expect(plan.deleteCache).not.toContain('h:b');
  });

  test('session removed from the drawer forgets its cursor and cache', () => {
    // 'b' is gone from the drawer entirely (killed / closed).
    const plan = reconcileResidency({
      drawerKeys: ['h:a'],
      wantedKeys: ['h:a'],
      cachedIds: ['h:a', 'h:b'],
    });
    expect(plan.forgetCursor).toContain('h:b');
    expect(plan.deleteCache).toContain('h:b');
  });

  test('mounted session is never torn down even if absent from the drawer poll', () => {
    // A just-started session can be in the tree before the drawer poll catches up.
    const plan = reconcileResidency({
      drawerKeys: [],
      wantedKeys: ['h:a'],
      cachedIds: ['h:a'],
    });
    expect(plan.forgetCursor).toEqual([]);
    expect(plan.deleteCache).toEqual([]);
  });

  test('nothing stale is a no-op', () => {
    const plan = reconcileResidency({
      drawerKeys: ['h:a'],
      wantedKeys: ['h:a'],
      cachedIds: ['h:a'],
    });
    expect(plan).toEqual({ deleteCache: [], forgetCursor: [] });
  });
});

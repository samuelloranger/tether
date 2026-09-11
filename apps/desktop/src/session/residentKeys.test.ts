import { describe, expect, test } from 'bun:test';
import { newLeaf, splitLeaf } from '@/pane/paneTree';
import { liveSessionKeys, residentKeys } from './residentKeys';

const S = (id: string) => ({ hostId: 'h', sessionId: id });

describe('residentKeys', () => {
  test('returns a session key per non-empty leaf', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    expect(residentKeys(tree).sort()).toEqual(['h:1', 'h:2']);
  });
  test('skips empty leaves', () => {
    const root = newLeaf(null);
    expect(residentKeys(root)).toEqual([]);
  });
});

test('liveSessionKeys keeps a leaf whose host has no health entry yet', () => {
  const views = [
    {
      id: 'v1',
      focusedPaneId: 'p1',
      tree: { kind: 'leaf' as const, id: 'p1', session: { hostId: 'h2', sessionId: 's9' } },
    },
  ];
  const keys = liveSessionKeys([], views, { h1: 'reachable' });
  expect(keys.has('h2:s9')).toBe(true);
});

test('liveSessionKeys drops a leaf whose host is known and has no session', () => {
  const views = [
    {
      id: 'v1',
      focusedPaneId: 'p1',
      tree: { kind: 'leaf' as const, id: 'p1', session: { hostId: 'h1', sessionId: 's9' } },
    },
  ];
  const keys = liveSessionKeys([], views, { h1: 'reachable' });
  expect(keys.has('h1:s9')).toBe(false);
});

import { describe, expect, test } from 'bun:test';
import { newLeaf, splitLeaf } from './paneTree';
import { residentKeys } from './residentKeys';

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

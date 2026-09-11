import { describe, expect, test } from 'bun:test';
import { leaves, newLeaf, splitLeaf } from './paneTree';
import { deserializePaneTree, prunePaneTree, serializePaneTree } from './paneTreeSerialize';

const S = (id: string) => ({ hostId: 'h', sessionId: id });

describe('paneTreeSerialize', () => {
  test('round-trips a nested tree', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    const back = deserializePaneTree(serializePaneTree(tree));
    expect(back).not.toBeNull();
    if (!back) throw new Error('unreachable');
    expect(
      leaves(back)
        .map((l) => l.session?.sessionId)
        .sort(),
    ).toEqual(['1', '2']);
  });

  test('malformed json returns null, never throws', () => {
    expect(deserializePaneTree('not json')).toBeNull();
    expect(deserializePaneTree(null)).toBeNull();
    expect(deserializePaneTree('{"kind":"bogus"}')).toBeNull();
  });

  test('prune clears leaves whose session is not live', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    const pruned = prunePaneTree(tree, new Set(['h:1']));
    const sessions = leaves(pruned).map((l) => l.session?.sessionId ?? null);
    expect(sessions).toHaveLength(2);
    expect(sessions).toContain('1');
    expect(sessions).toContain(null);
  });
});

import { describe, expect, test } from 'bun:test';
import { closePane, findLeaf, leaves, newLeaf, setRatio, setSession, splitLeaf } from './paneTree';

const S = (id: string) => ({ hostId: 'h', sessionId: id });

describe('paneTree', () => {
  test('newLeaf holds its session and a unique id', () => {
    const a = newLeaf(S('1'));
    const b = newLeaf(S('2'));
    expect(a.kind).toBe('leaf');
    expect(a.session).toEqual(S('1'));
    expect(a.id).not.toBe(b.id);
  });

  test('splitLeaf replaces the target with a branch, new leaf on the given side', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    expect(tree.kind).toBe('branch');
    if (tree.kind !== 'branch') throw new Error('unreachable');
    expect(tree.dir).toBe('row');
    expect(tree.ratio).toBe(0.5);
    expect((tree.a as { session: unknown }).session).toEqual(S('1'));
    expect((tree.b as { session: unknown }).session).toEqual(S('2'));
  });

  test('splitLeaf on side a puts the new leaf first', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'col', 'a', S('2'));
    if (tree.kind !== 'branch') throw new Error('unreachable');
    expect((tree.a as { session: unknown }).session).toEqual(S('2'));
    expect((tree.b as { session: unknown }).session).toEqual(S('1'));
  });

  test('leaves and findLeaf walk the whole tree', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    expect(
      leaves(tree)
        .map((l) => l.session?.sessionId)
        .sort(),
    ).toEqual(['1', '2']);
    if (tree.kind !== 'branch') throw new Error('unreachable');
    expect(findLeaf(tree, tree.b.id)?.session).toEqual(S('2'));
    expect(findLeaf(tree, 'nope')).toBeNull();
  });

  test('closePane collapses the parent to the surviving sibling', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    if (tree.kind !== 'branch') throw new Error('unreachable');
    const closed = closePane(tree, tree.b.id);
    expect(closed.kind).toBe('leaf');
    expect((closed as { session: unknown }).session).toEqual(S('1'));
  });

  test('closing the last leaf yields a fresh empty leaf', () => {
    const root = newLeaf(S('1'));
    const closed = closePane(root, root.id);
    expect(closed.kind).toBe('leaf');
    expect((closed as { session: unknown }).session).toBeNull();
  });

  test('setSession fills an empty leaf', () => {
    const root = newLeaf(null);
    const filled = setSession(root, root.id, S('9'));
    expect((filled as { session: unknown }).session).toEqual(S('9'));
  });

  test('setRatio clamps to [0.1, 0.9]', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    if (tree.kind !== 'branch') throw new Error('unreachable');
    expect((setRatio(tree, tree.id, 0.02) as typeof tree).ratio).toBeCloseTo(0.1);
    expect((setRatio(tree, tree.id, 0.99) as typeof tree).ratio).toBeCloseTo(0.9);
  });

  test('ops are no-ops on unknown ids', () => {
    const root = newLeaf(S('1'));
    expect(splitLeaf(root, 'x', 'row', 'b', S('2'))).toBe(root);
    expect(setSession(root, 'x', S('2'))).toBe(root);
  });
});

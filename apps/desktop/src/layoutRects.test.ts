import { describe, expect, test } from 'bun:test';
import { DIVIDER_PX, layoutTree } from './layoutRects';
import { newLeaf, splitLeaf } from './paneTree';

const S = (id: string) => ({ hostId: 'h', sessionId: id });

describe('layoutTree', () => {
  test('a single leaf fills the container', () => {
    const root = newLeaf(S('1'));
    const { leaves, dividers } = layoutTree(root, 800, 600);
    expect(dividers).toHaveLength(0);
    expect(leaves[0].rect).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    expect(leaves[0].paneId).toBe(root.id);
  });

  test('a row split halves the width minus the divider', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    const { leaves, dividers } = layoutTree(tree, 800, 600, DIVIDER_PX);
    const avail = 800 - DIVIDER_PX;
    expect(leaves[0].rect.width).toBeCloseTo(avail * 0.5);
    expect(leaves[0].rect.height).toBe(600);
    expect(leaves[1].rect.left).toBeCloseTo(avail * 0.5 + DIVIDER_PX);
    expect(dividers).toHaveLength(1);
    expect(dividers[0].dir).toBe('row');
    expect(dividers[0].rect.width).toBe(DIVIDER_PX);
  });

  test('a col split divides height', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'col', 'b', S('2'));
    const { leaves } = layoutTree(tree, 800, 600, DIVIDER_PX);
    const avail = 600 - DIVIDER_PX;
    expect(leaves[0].rect.height).toBeCloseTo(avail * 0.5);
    expect(leaves[0].rect.width).toBe(800);
    expect(leaves[1].rect.top).toBeCloseTo(avail * 0.5 + DIVIDER_PX);
  });

  test('nested splits stay within the container', () => {
    const root = newLeaf(S('1'));
    let tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    if (tree.kind !== 'branch') throw new Error('unreachable');
    tree = splitLeaf(tree, tree.b.id, 'col', 'b', S('3'));
    const { leaves } = layoutTree(tree, 1000, 800, DIVIDER_PX);
    expect(leaves).toHaveLength(3);
    for (const l of leaves) {
      expect(l.rect.left).toBeGreaterThanOrEqual(0);
      expect(l.rect.top).toBeGreaterThanOrEqual(0);
      expect(l.rect.left + l.rect.width).toBeLessThanOrEqual(1000.001);
      expect(l.rect.top + l.rect.height).toBeLessThanOrEqual(800.001);
    }
  });
});

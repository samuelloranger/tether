import { describe, expect, test } from 'bun:test';
import { firstLeafId, leaves, newLeaf, splitLeaf } from './paneTree';
import { serializePaneTree } from './paneTreeSerialize';
import type { View } from './viewModel';
import { deserializeViews, serializeViews } from './viewsSerialize';

const S = (id: string) => ({ hostId: 'h', sessionId: id });

describe('viewsSerialize', () => {
  test('round-trips views and activeViewId', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'row', 'b', S('2'));
    const solo = newLeaf(S('3'));
    const payload = {
      views: [
        { id: 'v1', tree, focusedPaneId: firstLeafId(tree) },
        { id: 'v2', tree: solo, focusedPaneId: solo.id },
      ] satisfies View[],
      activeViewId: 'v2',
    };
    const back = deserializeViews(serializeViews(payload));
    expect(back).toEqual(payload);
  });

  test('malformed json returns null, never throws', () => {
    expect(deserializeViews('not json')).toBeNull();
    expect(deserializeViews(null)).toBeNull();
    expect(deserializeViews('{"views":"nope"}')).toBeNull();
    expect(deserializeViews('{"kind":"bogus"}')).toBeNull();
  });

  test('old single-tree payload migrates to one view wrapping that tree', () => {
    const tree = newLeaf(S('1'));
    const back = deserializeViews(serializePaneTree(tree));
    expect(back).not.toBeNull();
    if (!back) throw new Error('unreachable');
    expect(back.views).toHaveLength(1);
    expect(back.views[0].tree).toEqual(tree);
    expect(back.views[0].focusedPaneId).toBe(firstLeafId(tree));
    expect(back.activeViewId).toBe(back.views[0].id);
    expect(back.views[0].id.length).toBeGreaterThan(0);
  });

  test('old nested split migrates losslessly as one group view', () => {
    const root = newLeaf(S('1'));
    const tree = splitLeaf(root, root.id, 'col', 'a', S('2'));
    const back = deserializeViews(serializePaneTree(tree));
    expect(back).not.toBeNull();
    if (!back) throw new Error('unreachable');
    expect(back.views).toHaveLength(1);
    expect(
      leaves(back.views[0].tree)
        .map((l) => l.session?.sessionId)
        .sort(),
    ).toEqual(['1', '2']);
    expect(back.views[0].focusedPaneId).toBe(firstLeafId(tree));
  });
});

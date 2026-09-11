import { describe, expect, test } from 'bun:test';
import type { ViewState } from './viewModel';
import {
  addSoloViewOp,
  closePaneOp,
  dropIntoPaneOp,
  fillPaneOp,
  focusPaneOp,
  openSessionOp,
  openViewOp,
  patchActiveView,
  reconcileOp,
  setRatioOp,
  splitFromTabOp,
  splitPaneOp,
  statesEqual,
} from './viewOps';

const KEY_1 = 'h1:s1';
const KEY_2 = 'h1:s2';

function solo(sessionId: string | null): ViewState {
  return {
    activeViewId: 'v1',
    views: [
      {
        id: 'v1',
        focusedPaneId: 'p1',
        tree: { kind: 'leaf', id: 'p1', session: sessionId ? { hostId: 'h1', sessionId } : null },
      },
    ],
  };
}

describe('statesEqual', () => {
  test('two structurally identical states compare equal', () => {
    expect(statesEqual(solo('s1'), solo('s1'))).toBe(true);
  });

  test('a different session makes them unequal', () => {
    expect(statesEqual(solo('s1'), solo('s2'))).toBe(false);
  });
});

describe('patchActiveView', () => {
  test('patches only the active view', () => {
    const views = [
      { id: 'v1', focusedPaneId: 'p1', tree: { kind: 'leaf' as const, id: 'p1', session: null } },
      { id: 'v2', focusedPaneId: 'p2', tree: { kind: 'leaf' as const, id: 'p2', session: null } },
    ];
    const next = patchActiveView(views, 'v2', (view) => ({ ...view, focusedPaneId: 'patched' }));
    expect(next[0].focusedPaneId).toBe('p1');
    expect(next[1].focusedPaneId).toBe('patched');
  });
});

describe('splitPaneOp', () => {
  test('turns a leaf into a branch with an empty second pane', () => {
    const next = splitPaneOp(solo('s1'), 'p1', 'row', 'b');
    expect(next.views[0].tree.kind).toBe('branch');
    expect(next.activeViewId).toBe('v1');
  });
});

describe('closePaneOp', () => {
  test('closing one half of a split leaves the other', () => {
    const split = splitPaneOp(solo('s1'), 'p1', 'row', 'b');
    const openPane = split.views[0].tree;
    if (openPane.kind !== 'branch') throw new Error('expected a branch');
    const next = closePaneOp(split, openPane.b.id, new Set([KEY_1]));
    expect(next.views[0].tree.kind).toBe('leaf');
  });
});

describe('fillPaneOp', () => {
  test('places a session into the pane and focuses it', () => {
    const next = fillPaneOp(solo(null), 'p1', { hostId: 'h1', sessionId: 's1' }, new Set([KEY_1]));
    const tree = next.views[0].tree;
    if (tree.kind !== 'leaf') throw new Error('expected a leaf');
    expect(tree.session?.sessionId).toBe('s1');
    expect(next.views[0].focusedPaneId).toBe(tree.id);
  });
});

describe('focusPaneOp', () => {
  test('moves focus without touching the tree', () => {
    const before = solo('s1');
    const next = focusPaneOp(before, 'other');
    expect(next.views[0].focusedPaneId).toBe('other');
    expect(next.views[0].tree).toEqual(before.views[0].tree);
  });
});

describe('setRatioOp', () => {
  test('sets the ratio on the named branch', () => {
    const split = splitPaneOp(solo('s1'), 'p1', 'row', 'b');
    const branch = split.views[0].tree;
    if (branch.kind !== 'branch') throw new Error('expected a branch');
    const next = setRatioOp(split, branch.id, 0.25);
    const after = next.views[0].tree;
    if (after.kind !== 'branch') throw new Error('expected a branch');
    expect(after.ratio).toBe(0.25);
  });
});

describe('openViewOp', () => {
  test('returns the same object when the view is already active', () => {
    const before = solo('s1');
    expect(openViewOp(before, 'v1')).toBe(before);
  });

  test('switches the active view id', () => {
    const before = solo('s1');
    const withSecond = addSoloViewOp(before, {
      id: 'v2',
      focusedPaneId: 'p9',
      tree: { kind: 'leaf', id: 'p9', session: { hostId: 'h1', sessionId: 's2' } },
    });
    expect(openViewOp(withSecond, 'v1').activeViewId).toBe('v1');
  });
});

describe('openSessionOp', () => {
  test('activates the view that already holds the session', () => {
    const base = solo('s1');
    const twoViews = addSoloViewOp(base, {
      id: 'v2',
      focusedPaneId: 'p9',
      tree: { kind: 'leaf', id: 'p9', session: { hostId: 'h1', sessionId: 's2' } },
    });
    const next = openSessionOp(twoViews, 'h1', 's1', 'p1', new Set([KEY_1, KEY_2]));
    expect(next.activeViewId).toBe('v1');
  });

  test('fills the fallback pane when no view holds the session', () => {
    const next = openSessionOp(solo(null), 'h1', 's1', 'p1', new Set([KEY_1]));
    const tree = next.views[0].tree;
    if (tree.kind !== 'leaf') throw new Error('expected a leaf');
    expect(tree.session?.sessionId).toBe('s1');
  });
});

describe('addSoloViewOp', () => {
  test('appends the view and makes it active', () => {
    const view = {
      id: 'v2',
      focusedPaneId: 'p9',
      tree: { kind: 'leaf' as const, id: 'p9', session: { hostId: 'h1', sessionId: 's2' } },
    };
    const next = addSoloViewOp(solo('s1'), view);
    expect(next.views).toHaveLength(2);
    expect(next.activeViewId).toBe('v2');
  });
});

describe('reconcileOp', () => {
  test('clears a leaf whose session is no longer live', () => {
    const next = reconcileOp(solo('s1'), new Set<string>());
    const tree = next.views[0].tree;
    if (tree.kind !== 'leaf') throw new Error('expected a leaf');
    expect(tree.session).toBeNull();
  });
});

describe('splitFromTabOp', () => {
  test('moves the session into a new pane of the active view', () => {
    const state = solo('s1');
    const next = splitFromTabOp(state, KEY_2, 'row', 'b', 'p1', new Set([KEY_1, KEY_2]));
    expect(next.views.some((view) => view.tree.kind === 'branch')).toBe(true);
  });
});

describe('dropIntoPaneOp', () => {
  test('a replace intent swaps the pane contents', () => {
    const next = dropIntoPaneOp(solo('s1'), 'p1', { kind: 'replace' }, KEY_2, new Set([KEY_2]));
    const tree = next.views[0].tree;
    if (tree.kind !== 'leaf') throw new Error('expected a leaf');
    expect(tree.session?.sessionId).toBe('s2');
  });
});

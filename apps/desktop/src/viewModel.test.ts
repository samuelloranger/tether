import { describe, expect, test } from 'bun:test';
import type { Branch, Leaf, PaneNode } from './paneTree';
import { closePane, firstLeafId, leaves, splitLeaf } from './paneTree';
import { sessionKey } from './sessionKey';
import type { DrawerSession, HostProfile } from './types';
import {
  aggregateDot,
  groupLabel,
  isGroup,
  moveSessionIntoView,
  newSoloView,
  reconcileViews,
  type View,
} from './viewModel';

const S = (sessionId: string, hostId = 'h') => ({ hostId, sessionId });

function leaf(id: string, sessionId: string | null, hostId = 'h'): Leaf {
  return { kind: 'leaf', id, session: sessionId ? S(sessionId, hostId) : null };
}

function branch(id: string, a: PaneNode, b: PaneNode, dir: 'row' | 'col' = 'row'): Branch {
  return { kind: 'branch', id, dir, a, b, ratio: 0.5 };
}

function view(id: string, tree: PaneNode, focusedPaneId?: string): View {
  return { id, tree, focusedPaneId: focusedPaneId ?? firstLeafId(tree) };
}

function sessionIds(v: View): Array<string | null> {
  return leaves(v.tree).map((l) => l.session?.sessionId ?? null);
}

function live(...ids: string[]): Set<string> {
  return new Set(ids.map((id) => (id.includes(':') ? id : sessionKey('h', id))));
}

function keysOf(views: View[]): string[] {
  return views.flatMap((v) =>
    leaves(v.tree).flatMap((l) =>
      l.session ? [sessionKey(l.session.hostId, l.session.sessionId)] : [],
    ),
  );
}

function found(views: View[], pred: (v: View) => boolean): View {
  const match = views.find(pred);
  if (!match) throw new Error('expected view');
  return match;
}

const hostA: HostProfile = {
  id: 'h',
  name: 'alpha',
  color: '#f00',
  host: 'a',
  port: '1',
  identityName: 'a',
  order: 0,
};

function drawer(id: string, extras: Partial<DrawerSession> = {}, hostId = 'h'): DrawerSession {
  return {
    hostId,
    id,
    status: 'running',
    last_output_at: null,
    ...extras,
  };
}

describe('isGroup / newSoloView', () => {
  test('a single leaf is not a group', () => {
    const v = newSoloView(S('1'));
    expect(isGroup(v)).toBe(false);
    expect(v.tree.kind).toBe('leaf');
    expect(v.focusedPaneId).toBe(firstLeafId(v.tree));
    expect(v.id.length).toBeGreaterThan(0);
  });

  test('two or more leaves make a group', () => {
    const solo = newSoloView(S('1'));
    const tree = splitLeaf(solo.tree, firstLeafId(solo.tree), 'row', 'b', S('2'));
    expect(isGroup({ ...solo, tree })).toBe(true);
  });
});

describe('reconcileViews', () => {
  test('empty session list keeps one empty solo view for the picker', () => {
    const a = view('a', leaf('p1', '1'));
    const b = view('b', leaf('p2', '2'));
    const { views, activeViewId } = reconcileViews([a, b], live(), 'a');
    expect(views).toHaveLength(1);
    expect(views[0].tree.kind).toBe('leaf');
    expect((views[0].tree as Leaf).session).toBeNull();
    expect(isGroup(views[0])).toBe(false);
    expect(activeViewId).toBe(views[0].id);
  });

  test('empty input still yields one empty solo view', () => {
    const { views, activeViewId } = reconcileViews([], live(), '');
    expect(views).toHaveLength(1);
    expect((views[0].tree as Leaf).session).toBeNull();
    expect(activeViewId).toBe(views[0].id);
  });

  test('duplicate session across views keeps the first and drops the rest', () => {
    const first = view('keep', leaf('p1', '1'));
    const second = view('drop', leaf('p2', '1'));
    const { views } = reconcileViews([first, second], live('1'), 'keep');
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe('keep');
    expect(sessionIds(views[0])).toEqual(['1']);
  });

  test('duplicate in a later group collapses that group after the extra is dropped', () => {
    const solo = view('first', leaf('p1', '1'));
    const grouped = view('g', branch('br', leaf('p2', '1'), leaf('p3', '2')));
    const { views } = reconcileViews([solo, grouped], live('1', '2'), 'first');
    expect(keysOf(views).sort()).toEqual(['h:1', 'h:2'].sort());
    const holder = views.find((v) => sessionIds(v).includes('1'));
    expect(holder?.id).toBe('first');
    expect(isGroup(found(views, (v) => sessionIds(v).includes('2')))).toBe(false);
  });

  test('active view pruned falls back to the first remaining view', () => {
    const empty = view('gone', leaf('p1', null));
    const alive = view('keep', leaf('p2', '1'));
    const { views, activeViewId } = reconcileViews([empty, alive], live('1'), 'gone');
    expect(views.map((v) => v.id)).toEqual(['keep']);
    expect(activeViewId).toBe('keep');
  });

  test('focused pane pruned resets to firstLeafId', () => {
    const tree = branch('br', leaf('pa', '1'), leaf('pb', '2'));
    const grouped = view('g', tree, 'pb');
    const { views } = reconcileViews([grouped], live('1'), 'g');
    expect(views).toHaveLength(1);
    expect(isGroup(views[0])).toBe(false);
    expect(sessionIds(views[0])).toEqual(['1']);
    expect(views[0].focusedPaneId).toBe(firstLeafId(views[0].tree));
    expect(views[0].focusedPaneId).not.toBe('pb');
  });

  test('cross-host group is preserved', () => {
    const tree = branch('br', leaf('pa', '1', 'h'), leaf('pb', '9', 'h2'));
    const grouped = view('g', tree);
    const { views } = reconcileViews(
      [grouped],
      new Set([sessionKey('h', '1'), sessionKey('h2', '9')]),
      'g',
    );
    expect(views).toHaveLength(1);
    expect(isGroup(views[0])).toBe(true);
    expect(leaves(views[0].tree).map((l) => l.session)).toEqual([S('1', 'h'), S('9', 'h2')]);
  });

  test('a group that shrinks to one pane becomes a solo tab', () => {
    const tree = branch('br', leaf('pa', '1'), leaf('pb', '2'));
    const grouped = view('g', tree);
    const { views } = reconcileViews([grouped], live('1'), 'g');
    expect(views).toHaveLength(1);
    expect(isGroup(views[0])).toBe(false);
    expect(sessionIds(views[0])).toEqual(['1']);
  });

  test('center-drop orphan: displaced live session gets a new solo view', () => {
    const other = view('o', leaf('po', '2'));
    // Simulate overwrite of t with session 2 (2 now in both; 1 gone from all leaves).
    const overwritten = view('t', leaf('pt', '2'));
    const { views } = reconcileViews([overwritten, other], live('1', '2'), 't');
    const keys = keysOf(views);
    expect(keys.sort()).toEqual(['h:1', 'h:2'].sort());
    expect(keys.filter((k) => k === 'h:2')).toHaveLength(1);
    expect(isGroup(found(views, (v) => sessionIds(v).includes('1')))).toBe(false);
  });

  test('orphans get a new solo view appended', () => {
    const existing = view('a', leaf('p1', '1'));
    const { views } = reconcileViews([existing], live('1', '2'), 'a');
    expect(views).toHaveLength(2);
    expect(views[0].id).toBe('a');
    expect(sessionIds(views[1])).toEqual(['2']);
    expect(isGroup(views[1])).toBe(false);
  });

  test('empty extra views are pruned but one empty solo is kept when nothing is live', () => {
    const a = view('a', leaf('p1', null));
    const b = view('b', leaf('p2', null));
    const { views } = reconcileViews([a, b], live(), 'a');
    expect(views).toHaveLength(1);
    expect((views[0].tree as Leaf).session).toBeNull();
  });

  test('all sessions on one host dying leave the other host live', () => {
    const host1 = view('a', leaf('p1', '1', 'h'));
    const host2 = view('b', leaf('p2', '9', 'h2'));
    const { views } = reconcileViews([host1, host2], new Set([sessionKey('h2', '9')]), 'a');
    expect(views).toHaveLength(1);
    expect(sessionIds(views[0])).toEqual(['9']);
    expect(views[0].id).toBe('b');
  });

  test('is idempotent', () => {
    const grouped = view('g', branch('br', leaf('pa', '1'), leaf('pb', '2')));
    const extra = view('x', leaf('px', '1'));
    const liveKeys = live('1', '2', '3');
    const once = reconcileViews([grouped, extra], liveKeys, 'x');
    const twice = reconcileViews(once.views, liveKeys, once.activeViewId);
    expect(twice).toEqual(once);
  });
});

describe('moveSessionIntoView', () => {
  test('split moves the session out of its old view into the target', () => {
    const target = view('t', leaf('pt', '1'));
    const source = view('s', leaf('ps', '2'));
    const { views } = moveSessionIntoView(
      [target, source],
      sessionKey('h', '2'),
      't',
      { kind: 'split', paneId: 'pt', dir: 'row', side: 'b' },
      live('1', '2'),
      't',
    );
    const dest = found(views, (v) => v.id === 't');
    expect(isGroup(dest)).toBe(true);
    expect(sessionIds(dest).sort()).toEqual(['1', '2']);
    expect(views.find((v) => v.id === 's')).toBeUndefined();
  });

  test('replace overwrites the target leaf and the displaced session pops to solo', () => {
    const target = view('t', leaf('pt', '1'));
    const source = view('s', leaf('ps', '2'));
    const { views } = moveSessionIntoView(
      [target, source],
      sessionKey('h', '2'),
      't',
      { kind: 'replace', paneId: 'pt' },
      live('1', '2'),
      't',
    );
    const dest = found(views, (v) => v.id === 't');
    expect(sessionIds(dest)).toEqual(['2']);
    expect(isGroup(found(views, (v) => sessionIds(v).includes('1')))).toBe(false);
    expect(keysOf(views).sort()).toEqual(['h:1', 'h:2'].sort());
  });
});

describe('groupLabel', () => {
  test('joins member titles with plus', () => {
    const v = view('g', branch('br', leaf('pa', '1'), leaf('pb', '2')));
    const label = groupLabel(
      v,
      [drawer('1', { name: 'claude' }), drawer('2', { name: 'shell' })],
      [hostA],
    );
    expect(label).toBe('claude + shell');
  });
});

describe('aggregateDot', () => {
  test('severity is waiting > working > done > idle', () => {
    const v = view('g', branch('br', leaf('pa', '1'), leaf('pb', '2')));
    const waiting = aggregateDot(v, [
      drawer('1', { activity: 'idle' }),
      drawer('2', { activity: 'waiting' }),
    ]);
    expect(waiting).toBe('waiting');
    const working = aggregateDot(v, [
      drawer('1', { activity: 'done' }),
      drawer('2', { activity: 'working' }),
    ]);
    expect(working).toBe('working');
    const done = aggregateDot(v, [
      drawer('1', { activity: 'idle' }),
      drawer('2', { activity: 'done' }),
    ]);
    expect(done).toBe('done');
  });
});

describe('close-then-reconcile shrink-to-one', () => {
  test('closing a group pane extracts the session to a new solo view', () => {
    const tree = branch('br', leaf('pa', '1'), leaf('pb', '2'));
    const grouped = view('g', tree, 'pb');
    const closed = { ...grouped, tree: closePane(grouped.tree, 'pb') };
    const { views } = reconcileViews([closed], live('1', '2'), 'g');
    const remaining = found(views, (v) => v.id === 'g');
    expect(isGroup(remaining)).toBe(false);
    expect(sessionIds(remaining)).toEqual(['1']);
    expect(isGroup(found(views, (v) => sessionIds(v).includes('2')))).toBe(false);
  });
});

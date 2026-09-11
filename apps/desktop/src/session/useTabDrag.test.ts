import { describe, expect, test } from 'bun:test';
import { paneDropTarget } from './useTabDrag';

const rect = { left: 100, top: 50, width: 300, height: 200 };

describe('paneDropTarget', () => {
  test('an empty pane always takes a full replace, ignoring position', () => {
    expect(paneDropTarget('p1', rect, 110, 60, true)).toEqual({
      paneId: 'p1',
      intent: { kind: 'replace' },
    });
  });

  test('a filled pane center is a replace', () => {
    // center of the pane in viewport coords: (250, 150)
    expect(paneDropTarget('p1', rect, 250, 150, false)).toEqual({
      paneId: 'p1',
      intent: { kind: 'replace' },
    });
  });

  test('a filled pane left edge splits row/a', () => {
    expect(paneDropTarget('p1', rect, 110, 150, false)).toEqual({
      paneId: 'p1',
      intent: { kind: 'split', dir: 'row', side: 'a' },
    });
  });

  test('a filled pane bottom edge splits col/b', () => {
    expect(paneDropTarget('p1', rect, 250, 245, false)).toEqual({
      paneId: 'p1',
      intent: { kind: 'split', dir: 'col', side: 'b' },
    });
  });

  test('the paneId is carried through', () => {
    expect(paneDropTarget('other', rect, 250, 150, false).paneId).toBe('other');
  });
});

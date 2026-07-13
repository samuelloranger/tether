import { describe, expect, it } from 'bun:test';
import { DRAG_PROPS, DRAG_REGION_CSS, NO_DRAG_PROPS } from './dragRegion';

describe('dragRegion', () => {
  it('CSS maps drag and no-drag regions, prefixed and unprefixed', () => {
    expect(DRAG_REGION_CSS).toContain('[data-tauri-drag-region]');
    expect(DRAG_REGION_CSS).toContain('[data-tauri-no-drag]');
    expect(DRAG_REGION_CSS).toContain('app-region: drag');
    expect(DRAG_REGION_CSS).toContain('-webkit-app-region: drag');
    expect(DRAG_REGION_CSS).toContain('app-region: no-drag');
    expect(DRAG_REGION_CSS).toContain('-webkit-app-region: no-drag');
  });
  it('prop bundles carry the expected data attributes', () => {
    // "deep" (not bare "") so clicks anywhere in the bar's subtree drag the
    // window — bare means "only direct clicks on the bar element", which never
    // fires because child Views cover it. See Tauri window/scripts/drag.js.
    expect(DRAG_PROPS.dataSet.tauriDragRegion).toBe('deep');
    expect(NO_DRAG_PROPS.dataSet.tauriNoDrag).toBe('');
  });
});

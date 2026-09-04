import { firstLeafId, type PaneNode } from './paneTree';
import { isValid } from './paneTreeSerialize';
import type { View, ViewState } from './viewModel';

export function serializeViews(state: ViewState): string {
  return JSON.stringify(state);
}

function wrapTree(tree: PaneNode): ViewState {
  const id = crypto.randomUUID();
  return {
    views: [{ id, tree, focusedPaneId: firstLeafId(tree) }],
    activeViewId: id,
  };
}

function isView(value: unknown): value is View {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.focusedPaneId === 'string' && isValid(v.tree);
}

function parseState(parsed: unknown): ViewState | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.activeViewId !== 'string' || !Array.isArray(o.views)) return null;
  if (o.views.length === 0 || !o.views.every(isView)) return null;
  return { views: o.views, activeViewId: o.activeViewId };
}

export function deserializeViews(json: string | null): ViewState | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (isValid(parsed)) return wrapTree(parsed);
    return parseState(parsed);
  } catch {
    return null;
  }
}

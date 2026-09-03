import type { Rect } from './layoutRects';
import type { PaneDir, PaneSide } from './paneTree';

export type DropIntent = { kind: 'split'; dir: PaneDir; side: PaneSide } | { kind: 'replace' };

export const EDGE_FRAC = 0.33;

/** dataTransfer MIME for dragging a session tab into a pane. Value = sessionKey. */
export const SESSION_DND_MIME = 'application/x-tether-session';

export function dropIntent(
  px: number,
  py: number,
  rect: Rect,
  edgeFrac: number = EDGE_FRAC,
): DropIntent {
  const fx = rect.width > 0 ? px / rect.width : 0.5;
  const fy = rect.height > 0 ? py / rect.height : 0.5;
  const distLeft = fx;
  const distRight = 1 - fx;
  const distTop = fy;
  const distBottom = 1 - fy;
  const nearest = Math.min(distLeft, distRight, distTop, distBottom);
  if (nearest > edgeFrac) return { kind: 'replace' };
  if (nearest === distLeft) return { kind: 'split', dir: 'row', side: 'a' };
  if (nearest === distRight) return { kind: 'split', dir: 'row', side: 'b' };
  if (nearest === distTop) return { kind: 'split', dir: 'col', side: 'a' };
  return { kind: 'split', dir: 'col', side: 'b' };
}

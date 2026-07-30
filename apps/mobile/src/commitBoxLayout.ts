import { MIN_TOUCH_TARGET } from './interaction';

export const MENU_WIDTH = 208;
export const MENU_GAP = 6;
export const MENU_ROW_HEIGHT = MIN_TOUCH_TARGET;

/** Place a menu above an anchor rect, right-aligned to it, clamped into the window. */
export function menuAboveAnchor(
  anchor: { x: number; y: number; width: number; height: number },
  window: { width: number; height: number },
  rowCount: number,
  menuWidth = MENU_WIDTH,
  gap = MENU_GAP,
): { left: number; top: number } {
  const menuHeight = Math.max(1, rowCount) * MENU_ROW_HEIGHT + 8;
  const left = Math.min(
    Math.max(8, anchor.x + anchor.width - menuWidth),
    Math.max(8, window.width - menuWidth - 8),
  );
  const top = Math.min(
    Math.max(8, anchor.y - menuHeight - gap),
    Math.max(8, window.height - menuHeight - 8),
  );
  return { left, top };
}

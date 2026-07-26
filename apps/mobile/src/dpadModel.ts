import { MIN_TOUCH_TARGET } from './interaction';

export const D_PAD_BUTTON_SIZE = MIN_TOUCH_TARGET;

export type DPadDirection = 'A' | 'B' | 'C' | 'D';

export const D_PAD_THRESHOLD = 8;

const SWITCH_RATIO = 1.25;
const THUMB_LIMIT = 11;

export function resolveDPadDirection(
  dx: number,
  dy: number,
  active: DPadDirection | null,
): DPadDirection | null {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (Math.max(horizontal, vertical) < D_PAD_THRESHOLD) return null;

  const candidate: DPadDirection =
    horizontal >= vertical ? (dx >= 0 ? 'C' : 'D') : dy >= 0 ? 'B' : 'A';
  if (!active || candidate === active) return candidate;

  const activeIsHorizontal = active === 'C' || active === 'D';
  const dominant = activeIsHorizontal ? horizontal : vertical;
  const opposing = activeIsHorizontal ? vertical : horizontal;
  return opposing < dominant * SWITCH_RATIO ? active : candidate;
}

export function thumbOffset(dx: number, dy: number): { x: number; y: number } {
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const scale = Math.min(THUMB_LIMIT / distance, 1);
  return { x: Math.round(dx * scale), y: Math.round(dy * scale) };
}

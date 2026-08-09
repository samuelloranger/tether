import { MIN_TOUCH_TARGET } from './interaction';

export const D_PAD_BUTTON_SIZE = MIN_TOUCH_TARGET;

export type DPadDirection = 'A' | 'B' | 'C' | 'D';

export const D_PAD_THRESHOLD = 8;

// Leading axis must clearly beat the trailing one before we lock a cardinal.
// 1.5× ≈ within ±34° of an axis — stops a left swipe with early vertical
// finger-roll from locking Down at the 8px threshold and sticking there.
export const D_PAD_DOMINANCE = 1.5;

// Auto-repeat: first key on activation, then one every D_PAD_REPEAT_MS after a
// D_PAD_REPEAT_DELAY_MS hold. Capped — an accidentally pinned finger would
// otherwise stream ~16 arrow keys/second into the PTY forever.
export const D_PAD_REPEAT_DELAY_MS = 350;
export const D_PAD_REPEAT_MS = 60;
export const D_PAD_MAX_REPEATS = 120;

const THUMB_LIMIT = 11;

// Direction is locked for the whole gesture once picked — a diagonal drag
// must not flip between axes mid-hold, else two arrow keys fire in quick
// succession and reads as diagonal movement in the terminal. Re-resolving
// only happens once the finger returns inside the center threshold.
export function resolveDPadDirection(
  dx: number,
  dy: number,
  active: DPadDirection | null,
): DPadDirection | null {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (Math.max(horizontal, vertical) < D_PAD_THRESHOLD) return null;
  if (active) return active;

  // Stay neutral in the diagonal band until one axis dominates — otherwise the
  // first noisy sample past threshold locks the wrong cardinal for the gesture.
  if (horizontal >= vertical) {
    if (horizontal < D_PAD_DOMINANCE * vertical) return null;
    return dx >= 0 ? 'C' : 'D';
  }
  if (vertical < D_PAD_DOMINANCE * horizontal) return null;
  return dy >= 0 ? 'B' : 'A';
}

// Where the touch landed inside the puck, as an offset from its center. A tap
// on a chevron is therefore already past D_PAD_THRESHOLD and fires that arrow —
// without this a plain tap resolves to no direction and does nothing at all.
// Drags then add the pan delta to this origin, so a gesture that starts off
// center is not double-counted.
export function grantOffset(locationX: number, locationY: number): { x: number; y: number } {
  const center = D_PAD_BUTTON_SIZE / 2;
  return { x: locationX - center, y: locationY - center };
}

// Icon rides the locked cardinal only — never free-slides diagonally.
// Travel uses hypot so an opposite/reverse-axis drift while locked still
// keeps the glyph engaged on that cardinal (matching auto-repeat) instead
// of collapsing to center when the axis component crosses zero.
export function thumbOffset(
  dx: number,
  dy: number,
  direction: DPadDirection | null,
): { x: number; y: number } {
  if (!direction) return { x: 0, y: 0 };
  const travel = Math.min(THUMB_LIMIT, Math.round(Math.hypot(dx, dy)));
  switch (direction) {
    case 'C':
      return { x: travel, y: 0 };
    case 'D':
      return { x: -travel, y: 0 };
    case 'B':
      return { x: 0, y: travel };
    case 'A':
      return { x: 0, y: -travel };
  }
}

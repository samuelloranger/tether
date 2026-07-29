import { MIN_TOUCH_TARGET } from './interaction';

export const D_PAD_BUTTON_SIZE = MIN_TOUCH_TARGET;

export type DPadDirection = 'A' | 'B' | 'C' | 'D';

export const D_PAD_THRESHOLD = 8;

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

  return horizontal >= vertical ? (dx >= 0 ? 'C' : 'D') : dy >= 0 ? 'B' : 'A';
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

export function thumbOffset(dx: number, dy: number): { x: number; y: number } {
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const scale = Math.min(THUMB_LIMIT / distance, 1);
  return { x: Math.round(dx * scale), y: Math.round(dy * scale) };
}

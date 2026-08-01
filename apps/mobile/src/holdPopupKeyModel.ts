// Pure gesture-decision logic for HoldPopupKey, kept separate so it's
// testable without mounting a PanResponder.

export const HOLD_POPUP_DELAY_MS = 350;
export const HOLD_POPUP_ALT_THRESHOLD = 24;

// dy is origin-touch-Y minus current-touch-Y: positive once the finger has
// slid up from where it landed.
export function resolveHoldPopupSelection(
  dy: number,
  threshold: number = HOLD_POPUP_ALT_THRESHOLD,
): boolean {
  return dy > threshold;
}

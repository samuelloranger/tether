export function availableOverlayHeight(
  viewportHeight: number,
  topOffset: number,
  bottomMargin: number,
): number {
  return Math.max(0, viewportHeight - topOffset - bottomMargin);
}

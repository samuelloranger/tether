export function availableOverlayHeight(
  viewportHeight: number,
  topOffset: number,
  bottomMargin: number,
): number {
  return Math.max(0, viewportHeight - topOffset - bottomMargin);
}

export function contentRelativeScrollStyle(maxHeight: number) {
  return {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight,
  } as const;
}

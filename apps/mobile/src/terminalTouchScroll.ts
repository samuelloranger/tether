export function touchScrollLines(
  deltaPixels: number,
  remainder: number,
  rowHeight: number,
): { lines: number; remainder: number } {
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return { lines: 0, remainder };
  const pixels = deltaPixels + remainder;
  const lines = Math.trunc(pixels / rowHeight);
  return { lines, remainder: pixels - lines * rowHeight };
}

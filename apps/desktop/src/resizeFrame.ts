export function resizeFrame(dims: { cols: number; rows: number } | undefined): {
  type: 'resize';
  cols: number;
  rows: number;
} {
  return { type: 'resize', cols: dims?.cols ?? 80, rows: dims?.rows ?? 24 };
}

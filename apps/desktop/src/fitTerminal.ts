import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

/** Rows that actually fit, given the viewport's pixel height and the painted
 *  cell height. FitAddon divides by a *fractional* cell height while the
 *  renderer rounds each cell UP to a device pixel, so on fractional-DPR or
 *  mid-font-load layouts it proposes one or two rows more than the grid can
 *  paint. Those extra rows render below the fold, and xterm caps the viewport's
 *  scrollHeight at its clientHeight — so they can never be scrolled into view.
 *  Clamping to `floor(height / paintedCell)` is the ceiling the paint obeys. */
export function rowsThatFit(
  viewportHeight: number,
  cellHeight: number,
  currentRows: number,
): number {
  if (!(cellHeight > 0) || !(viewportHeight > 0) || currentRows < 1) return currentRows;
  return Math.min(currentRows, Math.max(1, Math.floor(viewportHeight / cellHeight)));
}

/** Fits the terminal to its host, then shrinks the row count to what the
 *  viewport can actually paint (see `rowsThatFit`). Returns the corrected
 *  geometry — send THIS to the PTY, not `fit.proposeDimensions()`, which still
 *  reports the over-count. */
export function fitTerminal(
  term: Terminal,
  fit: FitAddon,
  container: HTMLElement | null | undefined,
): { cols: number; rows: number } {
  fit.fit();
  const screen = container?.querySelector<HTMLElement>('.xterm-screen');
  const viewport = container?.querySelector<HTMLElement>('.xterm-viewport');
  if (screen && viewport && term.rows > 0) {
    // `.xterm-screen` height is exactly rows * paintedCell, so this recovers the
    // rounded cell height the renderer used — no private xterm internals.
    const cellHeight = screen.getBoundingClientRect().height / term.rows;
    const fitRows = rowsThatFit(viewport.clientHeight, cellHeight, term.rows);
    if (fitRows !== term.rows) term.resize(term.cols, fitRows);
  }
  return { cols: term.cols, rows: term.rows };
}

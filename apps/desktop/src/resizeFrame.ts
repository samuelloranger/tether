export function resizeFrame(dims: { cols: number; rows: number } | undefined): {
  type: 'resize';
  cols: number;
  rows: number;
} {
  return { type: 'resize', cols: dims?.cols ?? 80, rows: dims?.rows ?? 24 };
}

/** Frames to send the moment a socket is live: connect-time `start` may be 80×24
 *  while the pane is already larger, and without a resize a TUI never sees SIGWINCH. */
export function socketOpenFrames(
  dims: { cols: number; rows: number } | undefined,
  focused: boolean,
): [{ type: 'resize'; cols: number; rows: number }, { type: 'focus'; focused: boolean }] {
  return [resizeFrame(dims), { type: 'focus', focused }];
}

/** CSI I / CSI O when the program enabled DECSET 1004 (xterm `sendFocusMode`). */
export function focusReportBytes(focused: boolean): string {
  return focused ? '\x1b[I' : '\x1b[O';
}

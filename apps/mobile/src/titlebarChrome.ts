// Pure per-platform decisions for the custom title bar. macOS keeps its native
// traffic lights (drawn by the OS via titleBarStyle: Overlay), so we render no
// custom window controls there and instead reserve a left inset the toolbar
// content leaves clear. Windows/Linux are frameless — we draw the controls.

// Width reserved on macOS for the three native traffic-light buttons. Empirical;
// confirm against the real Overlay geometry during manual testing.
export const MAC_TRAFFIC_LIGHT_INSET = 72;

export function titlebarChrome(isMac: boolean): { showControls: boolean; leftInset: number } {
  return {
    showControls: !isMac,
    leftInset: isMac ? MAC_TRAFFIC_LIGHT_INSET : 0,
  };
}

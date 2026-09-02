// Pure per-platform decisions for the custom title bar. macOS keeps its native
// traffic lights (drawn by the OS via titleBarStyle: Overlay), so we render no
// custom window controls there and instead reserve a left inset the toolbar
// content leaves clear. Windows/Linux are frameless — we draw the controls.

// Width reserved on macOS for the three native traffic-light buttons. Empirical;
// confirm against the real Overlay geometry during manual testing.
export const MAC_TRAFFIC_LIGHT_INSET = 72;

export function titlebarChrome(
  isMac: boolean,
  isFullscreen = false,
): { showControls: boolean; leftInset: number } {
  return {
    showControls: !isMac,
    // macOS reserves space for the native traffic lights — except in fullscreen,
    // where they're hidden, so the gutter collapses to reclaim the space.
    leftInset: isMac && !isFullscreen ? MAC_TRAFFIC_LIGHT_INSET : 0,
  };
}

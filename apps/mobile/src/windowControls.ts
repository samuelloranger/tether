// Custom-title-bar window controls (desktop/web only). Wraps @tauri-apps/api's
// window API, imported lazily so it never enters the mobile bundle (same pattern
// as src/dialog.ts). Used on Windows/Linux, where we draw our own min/max/close;
// macOS keeps its native traffic lights and does not call these.

async function win() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  await (await win()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  await (await win()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  await (await win()).close();
}

export async function isWindowMaximized(): Promise<boolean> {
  return (await win()).isMaximized();
}

// Fire cb with the current maximized state now and on every resize (maximize,
// restore, snap). Returns an unlisten function.
export async function onMaximizeChange(cb: (maximized: boolean) => void): Promise<() => void> {
  const w = await win();
  cb(await w.isMaximized());
  return w.onResized(async () => {
    cb(await w.isMaximized());
  });
}

// Fire cb with the current fullscreen state now and on every resize (entering/
// leaving native fullscreen resizes the window). Returns an unlisten function.
export async function onFullscreenChange(cb: (fullscreen: boolean) => void): Promise<() => void> {
  const w = await win();
  cb(await w.isFullscreen());
  return w.onResized(async () => {
    cb(await w.isFullscreen());
  });
}

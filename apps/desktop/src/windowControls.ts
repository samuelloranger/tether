// Custom-title-bar window controls. Thin wrapper over @tauri-apps/api's window
// API. Used on Windows/Linux, where we draw our own min/max/close; macOS keeps
// its native traffic lights (titleBarStyle: Overlay) and does not call these.

import { getCurrentWindow } from '@tauri-apps/api/window';

export async function minimizeWindow(): Promise<void> {
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  await getCurrentWindow().toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  await getCurrentWindow().close();
}

export async function isWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

// Fire cb with the current maximized state now and on every resize (maximize,
// restore, snap). Returns an unlisten function.
export async function onMaximizeChange(cb: (maximized: boolean) => void): Promise<() => void> {
  const w = getCurrentWindow();
  cb(await w.isMaximized());
  return w.onResized(async () => {
    cb(await w.isMaximized());
  });
}

// Fire cb with the current fullscreen state now and on every resize (entering/
// leaving native fullscreen resizes the window). Returns an unlisten function.
export async function onFullscreenChange(cb: (fullscreen: boolean) => void): Promise<() => void> {
  const w = getCurrentWindow();
  cb(await w.isFullscreen());
  return w.onResized(async () => {
    cb(await w.isFullscreen());
  });
}

// Custom window title bar for the frameless desktop build. Replaces the OS
// titlebar: the whole bar is a Tauri drag region (drag to move, double-click to
// maximize); interactive controls opt out via data-tauri-no-drag. macOS keeps
// native traffic lights (we reserve a left inset via titlebarChrome); Windows/
// Linux get the custom min/max/close cluster on the right.

import { useEffect, useState } from 'react';
import { titlebarChrome } from './titlebarChrome';
import {
  closeWindow,
  minimizeWindow,
  onFullscreenChange,
  onMaximizeChange,
  toggleMaximizeWindow,
} from './windowControls';

// This box is Linux (WebKitGTK); macOS reports "Mac" in the UA. Good enough to
// pick native traffic lights vs. our drawn controls — the only per-OS branch.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

interface TitleBarProps {
  title: string;
}

export function TitleBar({ title }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const { showControls, leftInset } = titlebarChrome(IS_MAC, fullscreen);

  useEffect(() => {
    if (!showControls) return;
    let unlisten: (() => void) | undefined;
    onMaximizeChange(setMaximized).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [showControls]);

  // macOS: the native traffic lights hide in fullscreen, so collapse the inset.
  useEffect(() => {
    if (!IS_MAC) return;
    let unlisten: (() => void) | undefined;
    onFullscreenChange(setFullscreen).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  return (
    <div className="titlebar" data-tauri-drag-region="deep">
      {leftInset > 0 ? <div style={{ width: leftInset }} /> : null}
      <span className="titlebar-title" data-tauri-drag-region="deep">
        {title}
      </span>
      {showControls ? (
        <div className="titlebar-controls">
          <button
            type="button"
            className="titlebar-btn"
            data-tauri-no-drag=""
            aria-label="Minimize"
            onClick={() => void minimizeWindow()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar-btn"
            data-tauri-no-drag=""
            aria-label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => void toggleMaximizeWindow()}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M2.5 2.5h5v5h-5z M3.5 2.5V1.5h5v5h-1"
                  stroke="currentColor"
                  strokeWidth="1"
                  fill="none"
                />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect
                  x="1"
                  y="1"
                  width="8"
                  height="8"
                  stroke="currentColor"
                  strokeWidth="1"
                  fill="none"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-btn-close"
            data-tauri-no-drag=""
            aria-label="Close"
            onClick={() => void closeWindow()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}

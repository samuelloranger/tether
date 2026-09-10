// Custom title bar for the frameless build. The title strip is a Tauri drag region;
// the control cluster is its sibling (not child) so button clicks aren't turned into drags.

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
    // `cancelled` guards the async gap: under StrictMode the cleanup can run before
    // the listener promise resolves, so unlisten an already-resolved one either way.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onMaximizeChange(setMaximized).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showControls]);

  // macOS: the native traffic lights hide in fullscreen, so collapse the inset.
  useEffect(() => {
    if (!IS_MAC) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onFullscreenChange(setFullscreen).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="titlebar">
      {leftInset > 0 ? <div style={{ width: leftInset }} /> : null}
      {/* Only the title strip is the drag handle: keeping controls OUT of the
          data-tauri-drag-region subtree stops button clicks becoming window drags. */}
      <span className="titlebar-title" data-tauri-drag-region>
        {title}
      </span>
      {showControls ? (
        <div className="titlebar-controls">
          <button
            type="button"
            className="titlebar-btn"
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

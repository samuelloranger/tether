import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';
import { isLightFlavor, type ResolvedFlavor } from './preferences';

/**
 * Keeps the native window chrome in step with the palette.
 *
 * The title bar follows the *window* theme, not our CSS variables, so choosing a
 * light flavour used to leave a black title bar above a light app — which reads
 * as a broken window rather than a light theme.
 *
 * Failure is swallowed on purpose: this is cosmetic, and a window API that
 * rejects must not take the app down with it.
 */
export function useWindowTheme(flavor: ResolvedFlavor): void {
  useEffect(() => {
    void getCurrentWindow()
      .setTheme(isLightFlavor(flavor) ? 'light' : 'dark')
      .catch(() => {});
  }, [flavor]);
}

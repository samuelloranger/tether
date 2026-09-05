import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';
import { isLightFlavor, type ResolvedFlavor } from './preferences';

/**
 * The title bar follows the *window* theme, not our CSS, so a light flavour would
 * leave a black title bar above a light app. Failure is swallowed — it's cosmetic.
 */
export function useWindowTheme(flavor: ResolvedFlavor): void {
  useEffect(() => {
    void getCurrentWindow()
      .setTheme(isLightFlavor(flavor) ? 'light' : 'dark')
      .catch(() => {});
  }, [flavor]);
}

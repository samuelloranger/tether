import { useEffect } from 'react';
import { checkForUpdates } from './desktopUpdater';

/**
 * Checks for an update once per launch.
 *
 * The client this one replaced checked at startup; this one only checked when
 * someone opened the overflow menu and picked "Check for updates", which means a
 * user who never opens that menu stays on the build they installed forever — the
 * updater is wired up and never fires.
 *
 * Silent: a failed check on launch (no network, GitHub unreachable) must not
 * open a dialog nobody asked for. Only a real available update speaks up.
 */
export function useLaunchUpdateCheck(): void {
  useEffect(() => {
    void checkForUpdates({ silent: true });
  }, []);
}

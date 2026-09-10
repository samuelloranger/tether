import { useEffect } from 'react';
import { checkForUpdates } from './desktopUpdater';

/**
 * Checks for an update once per launch (the prior client only checked from the menu,
 * so a user who never opened it never updated). Silent: only a real update speaks up.
 */
export function useLaunchUpdateCheck(): void {
  useEffect(() => {
    void checkForUpdates({ silent: true });
  }, []);
}

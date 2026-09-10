import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { confirmAction, notify } from './dialog';

/**
 * `silent` suppresses the two outcomes only interesting to someone who asked,
 * so the same function can run unprompted at launch (see useLaunchUpdateCheck).
 */
export async function checkForUpdates(options: { silent?: boolean } = {}): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      if (!options.silent) {
        await notify('Up to date', "You're running the latest version of Tether.");
      }
      return;
    }
    const install = await confirmAction(
      'Update available',
      `Version ${update.version} is available (you have ${update.currentVersion}). Install now?`,
      { confirmLabel: 'Install' },
    );
    if (!install) {
      await update.close();
      return;
    }
    await update.downloadAndInstall();
    await relaunch();
  } catch {
    if (!options.silent) {
      await notify('Update check failed', 'Could not reach the update server.', 'error');
    }
  }
}

import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { confirmAction, notify } from './dialog';

export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      await notify('Up to date', "You're running the latest version of Tether.");
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
    await notify('Update check failed', 'Could not reach the update server.', 'error');
  }
}

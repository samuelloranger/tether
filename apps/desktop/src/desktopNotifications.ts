import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

let permissionGranted: boolean | null = null;

export async function ensureNotificationPermission(): Promise<void> {
  try {
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const result = await requestPermission();
      permissionGranted = result === 'granted';
    }
  } catch {
    // Plugin unavailable outside Tauri.
  }
}

export async function sendOsNotification(title: string, body: string): Promise<void> {
  try {
    if (permissionGranted === null) await ensureNotificationPermission();
    if (permissionGranted === false) return;
    sendNotification({ title, body });
  } catch {
    // Never let notification failure reach callers.
  }
}

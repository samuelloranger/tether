// Desktop native notifications via the Tauri notification plugin. No-op
// anywhere but the actual Tauri desktop runtime — callers gate on `isDesktop`
// before calling these (see useTetherApp.tsx).
let permissionGranted: boolean | null = null;

// Call once at app startup (eager, not lazy on first trigger — product
// decision). Safe to call again; a subsequent call after permission was
// granted is a cheap no-op (single isPermissionGranted() check).
export async function ensureNotificationPermission(): Promise<void> {
  const { isPermissionGranted, requestPermission } = await import(
    '@tauri-apps/plugin-notification'
  );
  permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    const result = await requestPermission();
    permissionGranted = result === 'granted';
  }
}

export async function notify(title: string, body: string): Promise<void> {
  if (permissionGranted !== true) return;
  const { sendNotification } = await import('@tauri-apps/plugin-notification');
  sendNotification({ title, body });
}

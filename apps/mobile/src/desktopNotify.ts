// Desktop native notifications. The actual send goes through the Rust command
// `send_os_notification`, which picks the right mechanism per platform: on
// Linux it shells out to `notify-send` (the Tauri/notify-rust plugin path
// flashes-and-vanishes on GNOME 46+ because the notification handle is dropped
// the instant show() returns — tauri #14095 / plugins-workspace #2566), and on
// macOS/Windows it uses the notification plugin. Callers gate on `isDesktop`.
let permissionGranted: boolean | null = null;

function loadPlugin() {
  return import('@tauri-apps/plugin-notification');
}

// Call once at app startup. On macOS/Windows this surfaces the OS permission
// prompt so the plugin-backed send (used there) can display. Linux has no
// permission model and uses notify-send, so this is a best-effort no-op there.
export async function ensureNotificationPermission(): Promise<void> {
  try {
    const { isPermissionGranted, requestPermission } = await loadPlugin();
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const result = await requestPermission();
      permissionGranted = result === 'granted';
    }
  } catch {
    // Plugin unavailable (e.g. plain-browser dev preview) — ignore.
  }
}

export async function notify(title: string, body: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('send_os_notification', { title, body });
  } catch {
    // Rust command missing/failed — fall back to the JS plugin (best-effort,
    // fire-and-forget so a hung permission request can't block it).
    try {
      const mod = await loadPlugin();
      mod.sendNotification({ title, body });
    } catch {
      // Nothing more we can do; never let a notification failure reach callers.
    }
  }
}

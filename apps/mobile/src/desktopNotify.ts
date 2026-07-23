// Desktop native notifications via the Tauri notification plugin. No-op
// anywhere but the actual Tauri desktop runtime — callers gate on `isDesktop`
// before calling these (see useTetherApp.tsx).
let permissionGranted: boolean | null = null;

function loadPlugin() {
  return import('@tauri-apps/plugin-notification');
}

// Call once at app startup (eager, not lazy on first trigger — product
// decision). Safe to call again; a subsequent call after permission was
// granted is a cheap no-op (single isPermissionGranted() check).
export async function ensureNotificationPermission(): Promise<void> {
  try {
    const { isPermissionGranted, requestPermission } = await loadPlugin();
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const result = await requestPermission();
      permissionGranted = result === 'granted';
    }
  } catch {
    // Plugin unavailable (e.g. plain-browser dev preview) — leave the verdict
    // unknown; notify() still best-effort attempts to send.
  }
}

export async function notify(title: string, body: string): Promise<void> {
  try {
    const mod = await loadPlugin();
    // Best-effort acquire if we don't already hold a grant. Crucially we do NOT
    // hard-gate the send on the verdict: Linux (libnotify/D-Bus, e.g. Fedora/
    // GNOME) has no real permission model, and a false/unresolved verdict there
    // must not silently swallow every notification. sendNotification is a no-op
    // on platforms that genuinely deny, so attempting is safe everywhere.
    if (permissionGranted !== true) {
      try {
        permissionGranted = await mod.isPermissionGranted();
        if (!permissionGranted) {
          permissionGranted = (await mod.requestPermission()) === 'granted';
        }
      } catch {
        // ignore — fall through and still attempt the send
      }
    }
    mod.sendNotification({ title, body });
  } catch {
    // Plugin missing or the send threw (e.g. D-Bus unavailable) — nothing more
    // we can do; never let a notification failure crash the caller.
  }
}

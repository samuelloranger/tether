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
    // Send FIRST, unconditionally. We must NOT await a permission request
    // before sending: on a Linux desktop portal requestPermission() can stay
    // pending indefinitely (no prompt is ever shown), which would drop the
    // very notification this path exists to deliver. sendNotification is a
    // no-op where a platform genuinely denies, so sending first is safe.
    mod.sendNotification({ title, body });
    // Refresh the grant out-of-band (fire-and-forget) for platforms that do
    // gate — never blocking, so a hung request can't stall future sends.
    if (permissionGranted !== true) {
      void (async () => {
        try {
          permissionGranted = await mod.isPermissionGranted();
          if (!permissionGranted) {
            permissionGranted = (await mod.requestPermission()) === 'granted';
          }
        } catch {
          // ignore — sends don't depend on this
        }
      })();
    }
  } catch {
    // Plugin missing or the send threw (e.g. D-Bus unavailable) — nothing more
    // we can do; never let a notification failure crash the caller.
  }
}

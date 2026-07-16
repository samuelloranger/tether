// Cross-platform dialogs. On the Tauri desktop build, react-native-web's
// Alert.alert and window.confirm render as WebKitGTK's native *script* dialogs —
// titled "JavaScript – <origin>" (e.g. "tauri://localhost"), and confirm() can't
// show custom buttons. The native Tauri dialog plugin was tried instead, but
// rfd 0.16's GTK3 message-dialog backend hardcodes a null parent to
// gtk_message_dialog_new, so the dialog never gets a WM_TRANSIENT_FOR hint and
// GNOME shows it as a second independent "Tether" window/taskbar entry. The
// xdg-portal alternative was investigated and rejected: rfd has no real portal
// implementation for message dialogs at all, only file/save dialogs — it always
// shells out to zenity as a separate, unparented, arbitrarily-positioned
// process, which is worse. Desktop alerts are rendered in-app instead (see
// AlertModal.tsx) via the queue below. Mobile keeps the native styled Alert.
import { Platform, Alert } from 'react-native';

const isDesktop = Platform.OS === 'web';

export type AlertRequest =
  | { kind: 'notify'; title: string; body: string; level: 'info' | 'error'; resolve: () => void }
  | {
      kind: 'confirm';
      title: string;
      body: string;
      confirmLabel: string;
      destructive: boolean;
      resolve: (ok: boolean) => void;
    };

// Only one alert renders at a time; anything queued behind it shows once the
// current one resolves — nothing is silently dropped, matching how native
// dialogs are effectively serial/blocking too.
const queue: AlertRequest[] = [];
let listener: ((req: AlertRequest | null) => void) | null = null;

function showNext() {
  listener?.(queue[0] ?? null);
}

// Called once by AlertModal on mount. Returns an unsubscribe function.
export function subscribeAlert(l: (req: AlertRequest | null) => void): () => void {
  listener = l;
  showNext();
  return () => {
    listener = null;
  };
}

function dequeueAndShowNext() {
  queue.shift();
  showNext();
}

// Informational dialog (single OK button).
export async function notify(
  title: string,
  body: string,
  kind: 'info' | 'error' = 'info',
): Promise<void> {
  if (isDesktop) {
    return new Promise<void>((resolve) => {
      queue.push({
        kind: 'notify',
        title,
        body,
        level: kind,
        resolve: () => {
          dequeueAndShowNext();
          resolve();
        },
      });
      if (queue.length === 1) showNext();
    });
  }
  Alert.alert(title, body);
}

// Cancel / confirm question. Resolves true only when the user confirms.
export async function confirmAction(
  title: string,
  body: string,
  opts: { confirmLabel?: string; destructive?: boolean } = {},
): Promise<boolean> {
  const { confirmLabel = 'OK', destructive = false } = opts;
  if (isDesktop) {
    return new Promise<boolean>((resolve) => {
      queue.push({
        kind: 'confirm',
        title,
        body,
        confirmLabel,
        destructive,
        resolve: (ok) => {
          dequeueAndShowNext();
          resolve(ok);
        },
      });
      if (queue.length === 1) showNext();
    });
  }
  return new Promise<boolean>((resolve) => {
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      {
        text: confirmLabel,
        style: destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}

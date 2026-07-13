// Cross-platform dialogs. On the Tauri desktop build, react-native-web's
// Alert.alert and window.confirm render as WebKitGTK's native *script* dialogs —
// titled "JavaScript – <origin>" (e.g. "tauri://localhost"), and confirm() can't
// show custom buttons. Route desktop dialogs through the Tauri dialog plugin
// instead: real OS dialogs, titled by the app. Mobile keeps the native styled
// Alert. The plugin is imported lazily so it never loads in the mobile bundle.
import { Platform, Alert } from 'react-native';

const isDesktop = Platform.OS === 'web';

// Informational dialog (single OK button).
export async function notify(
  title: string,
  body: string,
  kind: 'info' | 'error' = 'info',
): Promise<void> {
  if (isDesktop) {
    const { message } = await import('@tauri-apps/plugin-dialog');
    await message(body, { title, kind });
    return;
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
    const { confirm } = await import('@tauri-apps/plugin-dialog');
    return confirm(body, {
      title,
      kind: destructive ? 'warning' : 'info',
      okLabel: confirmLabel,
      cancelLabel: 'Cancel',
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

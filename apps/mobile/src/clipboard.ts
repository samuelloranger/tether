// Cross-platform clipboard. On the Tauri desktop build the webview's async
// Clipboard API gates *read* behind a permission the webview never grants — on
// Linux WebKitGTK `navigator.clipboard.readText()` rejects with NotAllowedError —
// so expo-clipboard's getStringAsync (which calls readText under the hood) throws
// and paste fails with "Could not read the clipboard". Writing has no such gate
// (and expo-clipboard falls back to execCommand), which is why copy worked but
// paste didn't. Route desktop clipboard through the Tauri clipboard-manager
// plugin, which reads/writes the native OS clipboard directly. Mobile keeps
// expo-clipboard. The plugin is imported lazily so it never loads in the mobile
// bundle. Mirrors the desktop/mobile split in dialog.ts.
import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';

const isDesktop = Platform.OS === 'web';

export async function readClipboard(): Promise<string> {
  if (isDesktop) {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
    return (await readText()) || '';
  }
  return Clipboard.getStringAsync();
}

export async function writeClipboard(text: string): Promise<void> {
  if (isDesktop) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return;
  }
  await Clipboard.setStringAsync(text);
}

import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { Terminal } from '@xterm/xterm';

export async function writeSystemClipboard(text: string): Promise<void> {
  if (!text) return;
  await writeText(text);
}

export function copyTerminalSelection(term: Terminal): Promise<void> {
  return writeSystemClipboard(term.getSelection());
}

export function isCopyChord(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c';
}

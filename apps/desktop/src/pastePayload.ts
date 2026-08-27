/** Mirror of `tether_core::pty_input::paste_payload` for the desktop paste path. */

export const PASTE_START = '\u001b[200~';
export const PASTE_END = '\u001b[201~';

/**
 * Bytes to send for a paste, fenced when the program has bracketed paste on.
 *
 * The clipboard is untrusted. Text carrying its own `ESC[201~` would close the
 * fence early, and everything after it would arrive as typing — the next
 * newline then runs as Enter. Strip markers whether or not the fence goes on.
 */
export function pastePayload(text: string, bracketed: boolean): string {
  const clean = text.split(PASTE_START).join('').split(PASTE_END).join('');
  if (bracketed) return `${PASTE_START}${clean}${PASTE_END}`;
  return clean;
}

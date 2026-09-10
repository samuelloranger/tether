/** Mirror of `tether_core::pty_input::paste_payload` for the desktop paste path. */

export const PASTE_START = '\u001b[200~';
export const PASTE_END = '\u001b[201~';

/**
 * The clipboard is untrusted: text carrying its own `ESC[201~` would close the
 * fence early, so markers are stripped whether or not the fence goes on.
 */
export function pastePayload(text: string, bracketed: boolean): string {
  const clean = text.split(PASTE_START).join('').split(PASTE_END).join('');
  if (bracketed) return `${PASTE_START}${clean}${PASTE_END}`;
  return clean;
}

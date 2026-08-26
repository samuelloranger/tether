/** Paste bridge so workspace upload can inject the server path into the active PTY. */

type PasteListener = (text: string) => void;

let listener: PasteListener | null = null;

export function setPasteListener(next: PasteListener | null): void {
  listener = next;
}

export function requestPaste(text: string): void {
  listener?.(text);
}

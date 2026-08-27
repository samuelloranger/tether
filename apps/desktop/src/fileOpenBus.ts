/** Bridge so terminal file-path links can open the workspace viewer. */

type FileOpenListener = (path: string, line?: number, column?: number) => void;

let listener: FileOpenListener | null = null;

export function setFileOpenListener(next: FileOpenListener | null): void {
  listener = next;
}

export function requestFileOpen(path: string, line?: number, column?: number): void {
  listener?.(path, line, column);
}

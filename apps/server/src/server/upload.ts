import { existsSync } from 'node:fs';
import path from 'node:path';

// Resolves the on-disk path for an uploaded file inside `dir`, rejecting any
// filename that would escape it (no path separators, no ..), and appending a
// numeric suffix ("-1", "-2", ...) before the extension if the name collides
// with an existing file.
//
// Rejects rather than sanitises. The function's existing contract is to throw on
// a name it will not honour, and a caller that asked to store `report:2024.pdf`
// is better served by an error it can surface than by a silent rename to
// something it never learns about — the uploaded name is how the user finds the
// file again.
export function resolveUploadPath(dir: string, filename: string): string {
  if (filename.includes('/') || filename.includes('\\') || filename === '..' || filename === '.') {
    throw new Error(`invalid filename: ${filename}`);
  }
  // An empty name makes path.join return `dir` itself, which always exists, so
  // the collision loop below walks off the end of the directory and starts
  // writing siblings named `<dir>-1`, `<dir>-2`. Checked on every platform: a
  // file with no name exists nowhere.
  if (filename === '') {
    throw new Error('invalid filename: (empty)');
  }
  // The one character no filesystem in play can hold. Node rejects it already,
  // but from far enough away that the error says nothing the caller can act on.
  if (filename.includes('\u0000')) {
    throw new Error('invalid filename: contains a NUL byte');
  }
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`);
    n++;
  }
  return candidate;
}

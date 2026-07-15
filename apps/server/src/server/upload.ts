import { existsSync } from 'node:fs';
import path from 'node:path';

// Resolves the on-disk path for an uploaded file inside `dir`, rejecting any
// filename that would escape it (no path separators, no ..), and appending a
// numeric suffix ("-1", "-2", ...) before the extension if the name collides
// with an existing file.
export function resolveUploadPath(dir: string, filename: string): string {
  if (filename.includes('/') || filename.includes('\\') || filename === '..' || filename === '.') {
    throw new Error(`invalid filename: ${filename}`);
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

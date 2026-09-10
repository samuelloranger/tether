/**
 * Splits a repo-relative path into directory and file name so the UI can
 * shrink the (shared) directory prefix instead of ellipsis-clipping the name.
 */
export function splitPath(path: string): { dir: string; base: string } {
  const cut = path.lastIndexOf('/');
  if (cut < 0) return { dir: '', base: path };
  return { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}

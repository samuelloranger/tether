/**
 * Splits a repo-relative path into the directory prefix and the file name.
 *
 * The git drawer used to render the whole path in one element with
 * `text-overflow: ellipsis`, which clips the *tail* — and since every path in a
 * monorepo shares its head, three different files all rendered as
 * `apps/desktop/src/A…`. Splitting lets the layout shrink the directory and keep
 * the name, which is the only part that identifies the file you are about to
 * stage or discard.
 */
export function splitPath(path: string): { dir: string; base: string } {
  const cut = path.lastIndexOf('/');
  if (cut < 0) return { dir: '', base: path };
  return { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}

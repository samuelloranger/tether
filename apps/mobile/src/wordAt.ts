// Word extraction for the terminal grid's double-tap-to-copy gesture.
// "Word" is shell-flavored: paths, flags, URLs, identifiers — anything you'd
// plausibly want on the clipboard as one unit.
const WORD_CH = /[A-Za-z0-9_@$%+=:~./-]/;

export function wordAtColumn(text: string, col: number): string | null {
  if (col < 0 || col >= text.length) return null;
  if (!WORD_CH.test(text[col])) return null;
  let start = col;
  while (start > 0 && WORD_CH.test(text[start - 1])) start--;
  let end = col + 1;
  while (end < text.length && WORD_CH.test(text[end])) end++;
  const word = text.slice(start, end);
  return word.trim() ? word : null;
}

import { existsSync } from 'node:fs';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Names the Win32 layer resolves to a device rather than a file, whatever
 * directory they are asked for.
 *
 * The reservation applies to the stem before the FIRST dot, so `CON.txt` and
 * `CON.txt.bak` are the console too. Opening one hands back a handle to the
 * device: the upload's bytes go to the console, the printer or the bit bucket,
 * and the route still reports success with a path that holds nothing.
 *
 * COM0/LPT0 are included because current Windows documentation lists them.
 */
const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 10 }, (_, i) => `COM${i}`),
  ...Array.from({ length: 10 }, (_, i) => `LPT${i}`),
]);

/**
 * Characters Win32 refuses in a filename, plus the one it accepts and
 * reinterprets.
 *
 * `:` is the dangerous member: it opens an NTFS alternate data stream, so
 * `notes.txt:hidden` writes into a stream hanging off `notes.txt` that no
 * directory listing shows. The write stays inside the upload directory, so this
 * is not a traversal — but the caller asked for a file and got an invisible
 * side-channel, and the `existsSync` collision loop below cannot see a stream,
 * so the same name can be written through repeatedly.
 *
 * The rest (`<>"|?*` and the C0 controls) simply cannot exist on NTFS. Rejecting
 * them here turns an obscure errno from deep inside `Bun.write` into the same
 * `invalid filename` every other bad name already gets.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the C0 range is precisely what NTFS forbids.
const WINDOWS_ILLEGAL = /[<>:"|?*\u0000-\u001f]/;

/**
 * Windows-only, and deliberately so.
 *
 * Every hazard below is a property of the Win32 path layer, not of the upload
 * feature: `a:b`, `CON` and `evil.txt.` are ordinary, legal, unremarkable
 * filenames on Linux and macOS. Applying these rules everywhere would reject
 * files a POSIX host can store perfectly well — a functional regression bought
 * for no security at all, because the threat does not exist there to mitigate.
 *
 * That is a different judgement from the `\` check the caller already makes on
 * both platforms, and the difference is the point: `\` has to go everywhere
 * because a name a Linux host accepts becomes a separator the moment it is
 * synced or served to a Windows client. These three do not travel that way; they
 * only misbehave on the host actually performing the open.
 */
function windowsFilenameProblem(filename: string): string | null {
  if (WINDOWS_ILLEGAL.test(filename)) {
    return 'contains a character Windows cannot store in a filename';
  }
  // Win32 strips trailing dots and spaces on the way to the filesystem, so
  // `evil.txt.` and `evil.txt ` both open `evil.txt`. That silently defeats the
  // collision suffixing below: `existsSync(dir + '\\evil.txt.')` consults the
  // stripped name too, but the suffix is appended to the name as written, so
  // `evil.txt.` and `evil.txt` are two spellings racing for one file and the
  // second upload overwrites the first instead of becoming `evil-1.txt`.
  if (/[. ]$/.test(filename)) {
    return 'ends with a dot or space, which Windows silently strips';
  }
  const stem = filename.split('.')[0] ?? '';
  if (WINDOWS_RESERVED.has(stem.toUpperCase())) {
    return 'is a reserved Windows device name';
  }
  return null;
}

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
  if (IS_WINDOWS) {
    const problem = windowsFilenameProblem(filename);
    if (problem) throw new Error(`invalid filename: ${filename} ${problem}`);
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

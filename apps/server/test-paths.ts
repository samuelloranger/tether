// Path helpers for tests. Lives beside test-preload.ts (outside src/) so none
// of it ships in the compiled binary.
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Canonicalize a temp-directory fixture so it matches what the code under test
 * will report back.
 *
 * On Windows `os.tmpdir()` hands back an 8.3 short path
 * (C:\Users\SAMUEL~1.LOR\AppData\Local\Temp), but anything that resolves the
 * directory for real — `git rev-parse --show-toplevel`, a shell's OSC 7, a
 * directory watcher — reports the long form. Comparing the two fails on a
 * difference that has nothing to do with the behaviour under test. Plain
 * `realpathSync` does NOT expand short names on Windows; only the native
 * variant does.
 *
 * POSIX is deliberately left untouched rather than routed through
 * `realpathSync`: on macOS that would rewrite /var/folders/... to
 * /private/var/folders/... and quietly change what existing assertions mean.
 */
export function canonicalFixture(dir: string): string {
  return IS_WINDOWS ? realpathSync.native(dir) : dir;
}

/**
 * Build the OSC 7 escape a shell would emit for `dir`, as a test can feed it
 * straight to recordChunk.
 *
 * A file URI's path component is rooted at "/" and uses forward slashes, so a
 * native Windows path needs both: C:\a\b becomes file://host/C:/a/b. Pasting
 * the raw path in instead yields "file://hostC:\a\b", which has no "/" after
 * the authority at all — liveCwd's FILE_URI_RE rightly refuses it, the cwd is
 * never recorded, and the git/file routes answer 409 "waiting for shell to
 * report its working directory". Mirrors what ptyShell's PowerShell profile
 * actually emits.
 */
export function osc7Chunk(dir: string, host = 'host'): string {
  const uriPath = IS_WINDOWS ? `/${dir.split('\\').join('/')}` : dir;
  return `\u001b]7;file://${host}${uriPath}\u0007`;
}

/**
 * Whether this host can create symlinks at all.
 *
 * Windows gates symlink creation behind Developer Mode or an elevated process,
 * so `symlinkSync` throws EPERM on a default install and the fixture for an
 * "escaping symlink" test cannot even be built. Probed once rather than
 * assumed from the platform: a developer who has enabled Developer Mode should
 * still get the coverage.
 */
export const CAN_SYMLINK: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), 'tether-symlink-probe-'));
  try {
    symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/**
 * Whether POSIX permission bits mean anything here.
 *
 * Windows has no mode bits: node maps chmod onto the read-only attribute, so a
 * 0o600 request reads back as 0o666 and asserting the exact mode tests nothing.
 * Confidentiality there rests on the ACL of the user profile the file lives
 * under, which is a different mechanism, not a weaker spelling of the same one.
 */
export const HAS_POSIX_MODES = process.platform !== 'win32';

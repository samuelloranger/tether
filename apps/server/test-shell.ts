// Shell-shaped helpers for the tests that drive a real PTY. Lives beside
// test-preload.ts (outside src/) so none of it ships in the compiled binary.
//
// The PTY tests used to hardcode `bash` and POSIX `cd -- "dir"` syntax. That is
// fine on Linux and macOS but says nothing on Windows, where the default shell
// is PowerShell or cmd — and where Git for Windows' bash would report MSYS
// paths (/c/Users/...) that no Windows API can resolve.
import path from 'node:path';
import { getDefaultShell } from './src/server/ptyShell';

const IS_WINDOWS = process.platform === 'win32';

/** The shell these PTY tests drive: the platform's real default. */
export const TEST_SHELL = IS_WINDOWS ? getDefaultShell() : 'bash';

/**
 * A `cd <dir>` line quoted for TEST_SHELL, terminated the way pressing Enter
 * is — a bare CR on Windows, since sending CRLF makes PowerShell read the LF
 * as a second Enter and drop into its `>>` continuation prompt.
 */
export function cdLine(dir: string, shell: string = TEST_SHELL): string {
  const name = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell') {
    // Single quotes are literal in PowerShell, so a Windows path needs no
    // backslash escaping; an embedded quote is escaped by doubling it.
    return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'\r`;
  }
  if (name === 'cmd') return `cd /d "${dir}"\r`;
  return `cd -- ${JSON.stringify(dir)}\n`;
}

/**
 * A line that makes TEST_SHELL emit an OSC 2 window-title sequence, quoted for
 * that shell and terminated the way cdLine is.
 *
 * The escape has to come out of the shell rather than be injected into the log
 * directly, because what is under test is the whole PTY path: shell → ConPTY /
 * ptmx → holder → sessionTitle. POSIX shells get `printf`; PowerShell has no
 * printf and its `echo` (Write-Output) appends a newline and re-encodes, so the
 * bytes go out through [Console]::Write verbatim. ESC is spelled [char]27
 * rather than the `e escape because Windows PowerShell 5.1 — the in-box
 * fallback when pwsh is not installed — does not understand `e.
 */
export function titleLine(title: string, shell: string = TEST_SHELL): string {
  const name = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell') {
    const quoted = title.replace(/'/g, "''");
    return `[Console]::Write([char]27 + ']2;' + '${quoted}' + [char]7)\r`;
  }
  // cmd cannot print a raw ESC, but its builtin `title` sets the console title
  // and ConPTY re-emits that to the pty as the OSC 2 this test is looking for.
  if (name === 'cmd') return `title ${title}\r`;
  return `printf '\\033]2;${title}\\007'\n`;
}

/**
 * How long a PTY test should wait for the shell to catch up.
 *
 * bash is interactive in tens of milliseconds; PowerShell needs roughly two
 * seconds to load its profiles and PSReadLine before it reads the first
 * keystroke, and slower again when several tests spawn shells at once. The old
 * flat 3s budget was a comfortable margin on POSIX and a coin flip on Windows.
 */
export const SHELL_TIMEOUT_MS = IS_WINDOWS ? 20_000 : 3_000;

/**
 * The per-test ceiling for a test that drives a real PTY, passed as bun:test's
 * third `test()` argument.
 *
 * bun's own default is 5s, and that is the number these tests were dying on: a
 * junit run of the server suite on this Windows box, with the machine loaded
 * the way it is when several `bun test --parallel` workers overlap, measured
 * the PTY tests at 2.8s-5.0s each (about 1s apiece idle). Spawning PowerShell
 * is most of it — it loads its profiles and PSReadLine before reading the first
 * keystroke — and the git fixtures around it pay ~200-380ms per `git` spawn
 * under that load, against ~5ms on Linux.
 *
 * The ceiling deliberately sits above one full SHELL_TIMEOUT_MS: if bun kills
 * the test first, the failure is an opaque "timed out after 5000ms" instead of
 * waitFor's own assertion naming the condition that never came true. Nothing
 * reaches this value in a healthy run — it is a backstop, not a delay.
 */
export const PTY_TEST_TIMEOUT_MS = IS_WINDOWS ? 30_000 : 15_000;

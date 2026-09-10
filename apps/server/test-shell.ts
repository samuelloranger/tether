// Shell-shaped helpers for the tests that drive a real PTY. Lives beside
// test-preload.ts (outside src/) so none of it ships in the compiled binary.

/** The shell these PTY tests drive. */
export const TEST_SHELL = 'bash';

/** A `cd <dir>` line, terminated the way pressing Enter is. */
export function cdLine(dir: string): string {
  return `cd -- ${JSON.stringify(dir)}\n`;
}

/**
 * A line that makes the shell emit an OSC 2 window-title sequence.
 *
 * The escape has to come out of the shell rather than be injected into the log
 * directly, because what is under test is the whole PTY path: shell → ptmx →
 * holder → sessionTitle.
 */
export function titleLine(title: string): string {
  return `printf '\\033]2;${title}\\007'\n`;
}

/** How long a PTY test should wait for the shell to catch up. */
export const SHELL_TIMEOUT_MS = 3_000;

/**
 * The per-test ceiling for a test that drives a real PTY, passed as bun:test's
 * third `test()` argument.
 *
 * Deliberately above one full SHELL_TIMEOUT_MS: if bun kills the test first,
 * the failure is an opaque "timed out after 5000ms" instead of waitFor's own
 * assertion naming the condition that never came true. Nothing reaches this
 * value in a healthy run — it is a backstop, not a delay.
 */
export const PTY_TEST_TIMEOUT_MS = 15_000;

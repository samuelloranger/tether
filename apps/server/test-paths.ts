// Path helpers for tests. Lives beside test-preload.ts (outside src/) so none
// of it ships in the compiled binary.

/**
 * Canonicalize a temp-directory fixture so it matches what the code under test
 * will report back.
 *
 * Deliberately a no-op rather than a `realpathSync`: on macOS that would
 * rewrite /var/folders/... to /private/var/folders/... and quietly change what
 * existing assertions mean. Kept as a named seam so that reasoning survives —
 * the mistake it guards against is adding the call, not omitting it.
 */
export function canonicalFixture(dir: string): string {
  return dir;
}

/**
 * Build the OSC 7 escape a shell would emit for `dir`, so a test can feed it
 * straight to recordChunk.
 */
export function osc7Chunk(dir: string, host = 'host'): string {
  return `\u001b]7;file://${host}${dir}\u0007`;
}

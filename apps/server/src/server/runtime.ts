import path from 'node:path';

// Embedded at compile time via `bun build --define process.env.TETHER_VERSION`.
// Dev (uncompiled) leaves it unset → 'dev'. Display only — NOT used to detect
// compiled mode (a `build:binary` run with no version still embeds 'dev').
export const VERSION = process.env.TETHER_VERSION ?? 'dev';

// Only a `--compile` standalone binary runs from the embedded bunfs filesystem
// (import.meta.dir === '/$bunfs/root'). Both a dev `bun run` and a bundled
// `bun run dist/index.js` have a real on-disk dir, so this stays false for them —
// they correctly take selfArgv's [bun, main.ts, ...] reexec path.
export const COMPILED = import.meta.dir.includes('$bunfs');

// main.ts path, used only in the non-compiled (bun reexec) branch of selfArgv.
const MAIN_PATH = path.join(import.meta.dir, 'main.ts');

// Build the argv to re-invoke THIS program with a subcommand. Compiled binary:
// [binary, sub, ...extra]. Dev (bun run): [bun, main.ts, sub, ...extra]. Either
// way the subcommand lands at process.argv[2] in the child.
export function selfArgv(sub: string, extra: string[] = []): string[] {
  return COMPILED
    ? [process.execPath, sub, ...extra]
    : [process.execPath, MAIN_PATH, sub, ...extra];
}

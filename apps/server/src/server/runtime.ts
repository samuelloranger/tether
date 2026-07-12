import path from 'node:path';

// Embedded at compile time via `bun build --define process.env.TETHER_VERSION`.
// Dev (uncompiled) leaves it unset → 'dev'.
export const VERSION = process.env.TETHER_VERSION ?? 'dev';
export const COMPILED = VERSION !== 'dev';

// main.ts path, used only in the dev branch of selfArgv (in the compiled binary
// import.meta.dir is a virtual path and this value is never read).
const MAIN_PATH = path.join(import.meta.dir, 'main.ts');

// Build the argv to re-invoke THIS program with a subcommand. Compiled binary:
// [binary, sub, ...extra]. Dev (bun run): [bun, main.ts, sub, ...extra]. Either
// way the subcommand lands at process.argv[2] in the child.
export function selfArgv(sub: string, extra: string[] = []): string[] {
  return COMPILED
    ? [process.execPath, sub, ...extra]
    : [process.execPath, MAIN_PATH, sub, ...extra];
}

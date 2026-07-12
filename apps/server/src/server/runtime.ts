import { existsSync } from 'node:fs';
import path from 'node:path';

// Embedded at compile time via `bun build --define process.env.TETHER_VERSION`.
// Dev (uncompiled) leaves it unset → 'dev'. Display only — NOT used to detect
// compiled mode (a `build:binary` run with no version still embeds 'dev').
export const VERSION = process.env.TETHER_VERSION ?? 'dev';

// main.ts path, used only in the dev branch of selfArgv.
const MAIN_PATH = path.join(import.meta.dir, 'main.ts');

// A standalone compiled binary can't see its source on disk (import.meta.dir is
// a virtual bunfs path); a dev run can. Detect that way, independent of VERSION.
export const COMPILED = !existsSync(MAIN_PATH);

// Build the argv to re-invoke THIS program with a subcommand. Compiled binary:
// [binary, sub, ...extra]. Dev (bun run): [bun, main.ts, sub, ...extra]. Either
// way the subcommand lands at process.argv[2] in the child.
export function selfArgv(sub: string, extra: string[] = []): string[] {
  return COMPILED
    ? [process.execPath, sub, ...extra]
    : [process.execPath, MAIN_PATH, sub, ...extra];
}

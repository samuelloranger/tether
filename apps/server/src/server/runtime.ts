import path from 'node:path';

// Embedded at compile time via `bun build --define process.env.TETHER_VERSION`.
// Dev (uncompiled) leaves it unset → 'dev'. Display only — NOT used to detect
// compiled mode (a `build:binary` run with no version still embeds 'dev').
//
// `||`, not `??`: an unset TETHER_VERSION makes build:binary substitute the
// empty string, and "" is a version nobody wants printed. The script cannot
// default it in the shell — Bun's built-in shell (the one that runs package
// scripts on Windows) expands $VAR but passes ${VAR:-default} through as a
// literal, which is how "${TETHER_VERSION:-dev}" ended up baked into a binary.
export const VERSION = process.env.TETHER_VERSION || 'dev';

// Only a `--compile` standalone binary runs from the embedded bunfs filesystem.
// Both a dev `bun run` and a bundled `bun run dist/index.js` have a real on-disk
// dir, so this stays false for them — they correctly take selfArgv's
// [bun, main.ts, ...] reexec path.
//
// The embedded root is spelled differently per platform: '/$bunfs/root' on
// POSIX, 'B:\~BUN\root' on Windows. Matching only the POSIX sentinel made every
// Windows binary believe it was running from source, which broke it three ways
// at once — selfArgv re-exec'd `tether.exe <main.ts path> serve`, so the daemon
// and every PTY holder got the subcommand at the wrong argv index and printed
// the help text instead of starting; and DB_PATH resolved relative to cwd
// rather than ~/.tether.
export const COMPILED = import.meta.dir.includes('$bunfs') || import.meta.dir.includes('~BUN');

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

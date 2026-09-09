// Bun test preload — runs before any test file imports ./db or ./app (both
// resolve state-file paths at import time). Guarantees the whole suite uses
// isolated temp paths so tests never touch the developer's live config DB or
// present-control-token file, regardless of which test file imports first.
// Honors explicit TETHER_DB_PATH / TETHER_PRESENT_CONTROL_TOKEN_FILE overrides.
import { setDefaultTimeout } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Windows CI runners spawn subprocesses (git, the PTY holder, powershell.exe)
// glacially under load — a cold git/holder start alone can eat several seconds,
// so tests that shell out routinely blew bun's 5000ms default and failed the
// server-windows gate for reasons unrelated to the code. Raise the ceiling
// there; it only lets a slow-but-correct test finish, and fast tests are
// unaffected. POSIX keeps the tight default so a genuine hang still surfaces.
if (process.platform === 'win32') setDefaultTimeout(20_000);

// A per-run DIRECTORY, not just a per-run filename.
//
// CONFIG_DIR is `dirname(TETHER_DB_PATH)` (paths.ts), and HOLDERS_DIR hangs off
// it — so putting every worker's DB straight in tmpdir collapsed all of them,
// and every past run, onto one shared `<tmp>/holders`. The PTY tests use fixed
// session ids, so `startSession('refresh-live-cwd')` would find the socket a
// previous run had left behind, `attach()` would succeed, and the test would
// silently drive a holder spawned minutes earlier in a temp directory that no
// longer exists — passing its stale cwd back as the answer.
//
// That is a Windows-shaped failure even though the path is shared everywhere:
// a POSIX holder is SIGHUPed when its shell dies and cleans its socket up,
// while a detached Windows holder just keeps running. The random suffix covers
// the rest of it — a pid alone is recycled between runs.
process.env.TETHER_DB_PATH ||= path.join(
  tmpdir(),
  `tether-test-${process.pid}-${randomBytes(4).toString('hex')}`,
  'tether.db',
);
process.env.TETHER_PRESENT_CONTROL_TOKEN_FILE ||= path.join(
  tmpdir(),
  `tether-test-present-token-${process.pid}`,
);

// Every test process creates its own temp state directories. Without this each
// worker would spawn `icacls` for each of them to apply an ACL no test asserts
// on — see winAcl.ts.
process.env.TETHER_SKIP_WINDOWS_ACL ||= '1';

// gitWatch does not install filesystem watchers on Windows (GIT_WATCH_ENABLED,
// see gitWatch.ts) — so tests opt the watcher back in to exercise it. NOT on
// Windows, though: bun's Windows fs.watch is unreliable (`handle.on is not a
// function`) and forcing the watcher there intermittently hung the CI job to
// its 15-min cap while testing a path that never ships on Windows anyway. The
// fs.watch-driven tests skip on Windows to match (see `watchTest` in
// gitWatch.test.ts); coverage stays on Linux/macOS.
if (process.platform !== 'win32') process.env.TETHER_GIT_WATCH ||= '1';

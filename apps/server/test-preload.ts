// Bun test preload — runs before any test file imports ./db or ./app (both
// resolve state-file paths at import time). Guarantees the whole suite uses
// isolated temp paths so tests never touch the developer's live config DB or
// present-control-token file, regardless of which test file imports first.
// Honors explicit TETHER_DB_PATH / TETHER_PRESENT_CONTROL_TOKEN_FILE overrides.
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

// gitWatch does not install filesystem watchers on Windows (see gitWatch.ts).
// The suite opts back in so the watcher is still exercised there: it is the
// platform whose notification semantics differ most, so testing the code path
// only on Linux and macOS would be testing it where it is least likely to break.
process.env.TETHER_GIT_WATCH ||= '1';

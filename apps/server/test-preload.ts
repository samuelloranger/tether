// Bun test preload — runs before any test file imports ./db or ./app (both
// resolve state-file paths at import time). Guarantees the whole suite uses
// isolated temp paths so tests never touch the developer's live config DB or
// present-control-token file, regardless of which test file imports first.
// Honors explicit TETHER_DB_PATH / TETHER_PRESENT_CONTROL_TOKEN_FILE overrides.
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.TETHER_DB_PATH ||= path.join(tmpdir(), `tether-test-${process.pid}.db`);
process.env.TETHER_PRESENT_CONTROL_TOKEN_FILE ||= path.join(
  tmpdir(),
  `tether-test-present-token-${process.pid}`,
);

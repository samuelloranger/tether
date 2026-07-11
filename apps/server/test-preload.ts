// Bun test preload — runs before any test file imports ./db (which resolves its
// path at import time). Guarantees the whole suite uses an isolated temp database
// so tests never touch the developer's live config DB, regardless of which test
// file imports db.ts first. Honors an explicit TETHER_DB_PATH override.
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.TETHER_DB_PATH ||= path.join(tmpdir(), `tether-test-${process.pid}.db`);

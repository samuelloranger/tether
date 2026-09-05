import { Database } from 'bun:sqlite';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { logInfo } from './log';
import { DB_PATH, OLD_DB_PATH, USING_DEFAULT_DB } from './paths';
import { COMPILED } from './runtime';
import { secureCreatedDir } from './winAcl';

const DB_DIR = path.dirname(DB_PATH);
// The DB holds the argon2 password hash — keep the dir owner-only.
const createdDbDir = mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
try {
  chmodSync(DB_DIR, 0o700);
} catch {}
// Both lines above are silent no-ops on Windows (node maps chmod onto the
// read-only attribute), which would leave the password hash resting on whatever
// ACL ~/.tether inherited. secureCreatedDir applies the equivalent grant, and
// only on the boot that actually created the directory — see winAcl.ts.
secureCreatedDir(createdDbDir);

// One-time migration: pre-binary installs kept the DB in the ~/.tether/app
// source copy. Only for the installed binary on its default path (never a dev
// run or a TETHER_DB_PATH override), and only if the new DB doesn't exist yet.
if (COMPILED && USING_DEFAULT_DB && !existsSync(DB_PATH) && existsSync(OLD_DB_PATH)) {
  logInfo(`Migrating database from ${OLD_DB_PATH} to ${DB_PATH}`);
  // The old DB runs in WAL mode; recently-committed rows (schema, sessions, the
  // password) may still live only in the -wal file. Copy the whole set so the
  // new DB replays the WAL on first open instead of losing that data.
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(OLD_DB_PATH + suffix)) {
      copyFileSync(OLD_DB_PATH + suffix, DB_PATH + suffix);
    }
  }
}

export const db = new Database(DB_PATH, { create: true });

// Incremental auto-vacuum needs a one-time VACUUM to add its pointer map to an
// existing database. Do that on clean startup, before the server begins serving
// requests; new databases can enable it before their first table is created.
const autoVacuum = (db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
if (autoVacuum !== 2) {
  const hasSchema = db.query('SELECT 1 FROM sqlite_schema LIMIT 1').get() !== null;
  db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  if (autoVacuum === 0 && hasSchema) db.exec('VACUUM;');
}
// WAL + relaxed sync: terminal logs are written on every PTY chunk (incl. each
// keystroke echo). Default rollback-journal fsyncs per insert, adding latency to
// the echo path. WAL removes per-write fsync — much lower input latency.
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
// --- Migrations System ---
const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS terminal_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        chunk TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_terminal_logs_session ON terminal_logs(session_id);
    `,
  },
  {
    version: 2,
    name: 'session_name',
    up: `ALTER TABLE sessions ADD COLUMN name TEXT;`,
  },
  {
    version: 3,
    name: 'pruned_watermark',
    up: `ALTER TABLE sessions ADD COLUMN pruned_before INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 4,
    name: 'settings',
    up: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: 'terminal_logs_session_id_index',
    // Composite index lets replay (WHERE session_id = ? AND id > ?, ORDER BY id)
    // resolve as an index range scan instead of filter-then-sort.
    up: `CREATE INDEX IF NOT EXISTS idx_terminal_logs_session_id ON terminal_logs(session_id, id);`,
  },
  {
    version: 6,
    name: 'session_workspace_root',
    up: `ALTER TABLE sessions ADD COLUMN workspace_root TEXT;`,
  },
  {
    version: 7,
    name: 'drop_redundant_session_index',
    // Fully covered by the composite idx_terminal_logs_session_id(session_id, id)
    // from migration 5; the single-column index only added write cost on the hot
    // per-keystroke insert path.
    up: `DROP INDEX IF EXISTS idx_terminal_logs_session;`,
  },
  {
    version: 8,
    name: 'push_devices',
    // One row per iOS device registered for APNs push against this server.
    // secret_key is the AES-GCM key that device generated for us; it never
    // leaves this table and the relay never sees it. Device tokens rotate, so
    // the token is the primary key and re-registration is an upsert.
    up: `
      CREATE TABLE IF NOT EXISTS push_devices (
        device_token TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL,
        label TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      );
    `,
  },
  {
    version: 9,
    name: 'auth_devices',
    // One row per authorized device public key — the authorized_keys allow-list
    // for Noise auth. pubkey is base64 of the 32-byte X25519 static key, unique.
    up: `
      CREATE TABLE IF NOT EXISTS auth_devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        pubkey TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        paired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME,
        last_address TEXT
      );
    `,
  },
  {
    version: 10,
    name: 'push_devices_auth_device_id',
    up: `ALTER TABLE push_devices ADD COLUMN auth_device_id TEXT;`,
  },
];

export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedRows = db.query('SELECT version FROM _migrations').all() as { version: number }[];
  const appliedMigrations = new Set(appliedRows.map((m) => m.version));

  const transaction = db.transaction(() => {
    for (const migration of migrations) {
      if (!appliedMigrations.has(migration.version)) {
        logInfo(`Running migration: ${migration.version}_${migration.name}`);
        db.exec(migration.up);
        db.query('INSERT INTO _migrations (version, name) VALUES ($version, $name)').run({
          $version: migration.version,
          $name: migration.name,
        });
      }
    }
  });

  transaction();
}

// Initialize database schema
runMigrations();
// A previous process can leave a large high-water WAL even after all readers
// are gone. Startup is the safe point to checkpoint it, after migration writes.
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

// --- DB Helper Functions ---

const LOG_CAP = 2000;
/** Hard ceiling on retained scrollback bytes per session (see pruneLogs). */
const LOG_BYTE_CAP = 8_000_000;
const insertCounts = new Map<string, number>();
type RetentionStats = { rows: number; bytes: number };
const retentionStats = new Map<string, RetentionStats>();
for (const row of db
  .query(
    `SELECT session_id, COUNT(*) AS rows, COALESCE(SUM(octet_length(chunk)), 0) AS bytes
     FROM terminal_logs GROUP BY session_id`,
  )
  .all() as { session_id: string; rows: number; bytes: number }[]) {
  retentionStats.set(row.session_id, { rows: row.rows, bytes: row.bytes });
}

function retained(sessionId: string): RetentionStats {
  let stats = retentionStats.get(sessionId);
  if (!stats) {
    stats = { rows: 0, bytes: 0 };
    retentionStats.set(sessionId, stats);
  }
  return stats;
}

/** Retained UTF-8 bytes for a session — an upper bound on any replay of it. */
export function retainedBytes(sessionId: string): number {
  return retained(sessionId).bytes;
}

function configuredLogCap(): number {
  try {
    const value = JSON.parse(getSetting('config.session') ?? '{}') as { scrollbackRows?: unknown };
    const rows = Number(value.scrollbackRows);
    return Number.isInteger(rows) && rows >= 100 && rows <= 100_000 ? rows : LOG_CAP;
  } catch {
    return LOG_CAP;
  }
}

export function pruneLogs(sessionId: string, cap = LOG_CAP, byteCap = LOG_BYTE_CAP) {
  const stats = retained(sessionId);
  if (stats.rows <= cap && stats.bytes <= byteCap) return;

  let removedRows = 0;
  let removedBytes = 0;
  let cut = 0;
  let afterId = 0;
  let done = false;
  while (!done) {
    const oldest = db
      .query(
        `SELECT id, octet_length(chunk) AS bytes FROM terminal_logs
         WHERE session_id = $id AND id > $afterId ORDER BY id ASC LIMIT 200`,
      )
      .all({ $id: sessionId, $afterId: afterId }) as { id: number; bytes: number }[];
    if (oldest.length === 0) break;
    for (const row of oldest) {
      const overRows = stats.rows - removedRows > cap;
      const overBytes = stats.bytes - removedBytes > byteCap;
      if ((!overRows && !overBytes) || stats.rows - removedRows <= 1) {
        done = true;
        break;
      }
      cut = row.id;
      removedRows++;
      removedBytes += row.bytes;
    }
    afterId = oldest[oldest.length - 1].id;
  }
  if (cut === 0) return;
  deleteLogsThrough(sessionId, cut, removedRows, removedBytes);
  // Reclaim a bounded number of pages per prune so retention stays close to its
  // steady-state disk footprint without turning the PTY output path into VACUUM.
  db.exec('PRAGMA incremental_vacuum(200);');
}

function deleteLogsThrough(
  sessionId: string,
  cut: number,
  removedRows: number,
  removedBytes: number,
) {
  db.query('DELETE FROM terminal_logs WHERE session_id = $id AND id <= $cut').run({
    $id: sessionId,
    $cut: cut,
  });
  const stats = retained(sessionId);
  stats.rows -= removedRows;
  stats.bytes -= removedBytes;
  // Watermark lets the WS gateway detect a client whose sinceId predates the
  // prune (gap in replay) and tell it to reset instead of rendering a hole.
  db.query('UPDATE sessions SET pruned_before = $cut WHERE id = $id AND pruned_before < $cut').run({
    $id: sessionId,
    $cut: cut,
  });
}

export interface Session {
  id: string;
  command: string;
  status: 'running' | 'stopped';
  created_at: string;
  name: string | null;
  pruned_before: number;
  workspace_root: string | null;
}

export interface TerminalLog {
  id: number;
  session_id: string;
  chunk: string;
  created_at: string;
}

export function getSession(id: string): Session | null {
  return db.query('SELECT * FROM sessions WHERE id = $id').get({ $id: id }) as Session | null;
}

export function upsertSession(
  id: string,
  command: string,
  status: 'running' | 'stopped' = 'running',
  workspaceRoot?: string,
) {
  db.query(`
    INSERT INTO sessions (id, command, status, workspace_root)
    VALUES ($id, $command, $status, $workspaceRoot)
    ON CONFLICT(id) DO UPDATE SET command = excluded.command, status = excluded.status
  `).run({ $id: id, $command: command, $status: status, $workspaceRoot: workspaceRoot ?? null });
}

export function addTerminalLog(sessionId: string, chunk: string): number {
  const result = db
    .query(`INSERT INTO terminal_logs (session_id, chunk) VALUES ($sessionId, $chunk)`)
    .run({ $sessionId: sessionId, $chunk: chunk });
  const stats = retained(sessionId);
  stats.rows++;
  stats.bytes += Buffer.byteLength(chunk);
  const n = (insertCounts.get(sessionId) ?? 0) + 1;
  insertCounts.set(sessionId, n);
  if (n % 200 === 0) pruneLogs(sessionId, configuredLogCap());
  return Number(result.lastInsertRowid);
}

export function getLogs(sessionId: string, sinceId = 0): TerminalLog[] {
  return db
    .query(`
    SELECT id, session_id, chunk, created_at
    FROM terminal_logs
    WHERE session_id = $sessionId AND id > $sinceId
    ORDER BY id ASC
  `)
    .all({ $sessionId: sessionId, $sinceId: sinceId }) as TerminalLog[];
}

export function clearLogs(sessionId: string) {
  db.query('DELETE FROM terminal_logs WHERE session_id = $sessionId').run({
    $sessionId: sessionId,
  });
  insertCounts.delete(sessionId);
  // Drop the entry rather than zeroing it: `retained()` recreates it on the next
  // insert, so keeping a zero row here would grow the map without bound across
  // transient sessions (same reason clearInsertCount exists).
  retentionStats.delete(sessionId);
}

// Drop just the in-memory prune counter (without touching logs) — call when a
// session stops but its logs are kept for replay, so the map doesn't grow
// unbounded across many transient sessions.
export function clearInsertCount(sessionId: string): void {
  insertCounts.delete(sessionId);
}

export function setSessionStatus(id: string, status: 'running' | 'stopped') {
  db.query('UPDATE sessions SET status = $status WHERE id = $id').run({ $id: id, $status: status });
}

// Called once at boot: any session still marked running belonged to a previous
// server process — its PTY is gone.
export function resetRunningSessions() {
  db.query(`UPDATE sessions SET status = 'stopped' WHERE status = 'running'`).run();
}

export function renameSession(id: string, name: string | null) {
  db.query('UPDATE sessions SET name = $name WHERE id = $id').run({ $id: id, $name: name });
}

// --- Settings (key/value) ---
export function getSetting(key: string): string | null {
  const row = db.query('SELECT value FROM settings WHERE key = $key').get({ $key: key }) as {
    value: string;
  } | null;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  db.query(`
    INSERT INTO settings (key, value) VALUES ($key, $value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ $key: key, $value: value });
}

// Fully remove a session (row + its logs) so it disappears from the list.
export function deleteSession(id: string) {
  clearLogs(id);
  db.query('DELETE FROM sessions WHERE id = $id').run({ $id: id });
  retentionStats.delete(id);
}

export interface SessionRow extends Session {
  last_output_at: string | null;
}

export function listSessions(): SessionRow[] {
  return db
    .query(
      `SELECT s.*,
        (SELECT created_at FROM terminal_logs WHERE session_id = s.id ORDER BY id DESC LIMIT 1)
          AS last_output_at
       FROM sessions s ORDER BY s.created_at DESC`,
    )
    .all() as SessionRow[];
}

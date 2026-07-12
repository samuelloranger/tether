import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DB_PATH, OLD_DB_PATH } from './paths';

const usingDefault = !process.env.TETHER_DB_PATH;
const DB_PATH = process.env.TETHER_DB_PATH ?? DEFAULT_DB_PATH;
const DB_DIR = path.dirname(DB_PATH);
mkdirSync(DB_DIR, { recursive: true });

// One-time migration: pre-binary installs kept the DB in the ~/.tether/app
// source copy. If we're on the default path, it doesn't exist yet, and the old
// one does, carry it over so sessions + the password survive the upgrade.
if (usingDefault && !existsSync(DB_PATH) && existsSync(OLD_DB_PATH)) {
  console.log(`Migrating database from ${OLD_DB_PATH} to ${DB_PATH}`);
  copyFileSync(OLD_DB_PATH, DB_PATH);
}

export const db = new Database(DB_PATH, { create: true });

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
        console.log(`Running migration: ${migration.version}_${migration.name}`);
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

// --- DB Helper Functions ---

const LOG_CAP = 2000;
const insertCounts = new Map<string, number>();

export function pruneLogs(sessionId: string, cap = LOG_CAP) {
  const cut = db
    .query(
      `SELECT id FROM terminal_logs WHERE session_id = $id
       ORDER BY id DESC LIMIT 1 OFFSET $cap`,
    )
    .get({ $id: sessionId, $cap: cap }) as { id: number } | null;
  if (!cut) return;
  db.query('DELETE FROM terminal_logs WHERE session_id = $id AND id <= $cut').run({
    $id: sessionId,
    $cut: cut.id,
  });
  // Watermark lets the WS gateway detect a client whose sinceId predates the
  // prune (gap in replay) and tell it to reset instead of rendering a hole.
  db.query('UPDATE sessions SET pruned_before = $cut WHERE id = $id AND pruned_before < $cut').run({
    $id: sessionId,
    $cut: cut.id,
  });
}

export interface Session {
  id: string;
  command: string;
  status: 'running' | 'stopped';
  created_at: string;
  name: string | null;
  pruned_before: number;
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
) {
  db.query(`
    INSERT INTO sessions (id, command, status)
    VALUES ($id, $command, $status)
    ON CONFLICT(id) DO UPDATE SET command = excluded.command, status = excluded.status
  `).run({ $id: id, $command: command, $status: status });
}

export function addTerminalLog(sessionId: string, chunk: string): number {
  const result = db
    .query(`INSERT INTO terminal_logs (session_id, chunk) VALUES ($sessionId, $chunk)`)
    .run({ $sessionId: sessionId, $chunk: chunk });
  const n = (insertCounts.get(sessionId) ?? 0) + 1;
  insertCounts.set(sessionId, n);
  if (n % 200 === 0) pruneLogs(sessionId);
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

const AUTH_HASH_KEY = 'auth_password_hash';
export function getAuthHash(): string | null {
  return getSetting(AUTH_HASH_KEY);
}
export function setAuthHash(hash: string): void {
  setSetting(AUTH_HASH_KEY, hash);
}

// Fully remove a session (row + its logs) so it disappears from the list.
export function deleteSession(id: string) {
  clearLogs(id);
  db.query('DELETE FROM sessions WHERE id = $id').run({ $id: id });
}

export interface SessionRow extends Session {
  last_output_at: string | null;
}

export function listSessions(): SessionRow[] {
  return db
    .query(
      `SELECT s.*,
        (SELECT MAX(created_at) FROM terminal_logs WHERE session_id = s.id) AS last_output_at
       FROM sessions s ORDER BY s.created_at DESC`,
    )
    .all() as SessionRow[];
}

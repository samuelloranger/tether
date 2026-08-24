import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// These two tests import db.ts in a child process, because its startup work
// (auto_vacuum upgrade, WAL truncate) is module-level and only runs once per
// process. Everything below exists to make sure a child that misbehaves fails
// the test *loudly* instead of hanging: an unreaped child holding a piped
// stdout keeps the whole test runner alive, which is how one bad run stalled CI
// for 23 minutes and then reported nothing.

/** Per-test ceiling. Generous for a slow runner, still bounded. */
const TEST_TIMEOUT_MS = 30_000;
/** How long we wait on a child before declaring it stuck. */
const CHILD_TIMEOUT_MS = 10_000;

/** Pinned to the pipe variant so stdout/stderr are streams, not fds. */
type Child = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

/** Runs `code` in a child bun, guaranteeing the process and its pipes are released. */
async function withChild<T>(code: string, dbPath: string, fn: (child: Child) => Promise<T>) {
  const child: Child = Bun.spawn([process.execPath, '-e', code], {
    env: { ...process.env, TETHER_DB_PATH: dbPath },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    return await fn(child);
  } finally {
    // Unconditional: the child may still be mid-sleep, stuck, or already gone.
    child.kill();
    await child.exited;
  }
}

/** Kills the child so its stderr reaches EOF, then reports why it was stuck. */
async function stuck(child: Child, waitingFor: string, seen: string): Promise<never> {
  child.kill();
  const stderr = await new Response(child.stderr).text().catch(() => '<unreadable>');
  throw new Error(
    `child never produced ${waitingFor} within ${CHILD_TIMEOUT_MS}ms\n` +
      `stdout so far: ${JSON.stringify(seen)}\nstderr: ${stderr}`,
  );
}

/** Waits for the child to exit, or fails with its output rather than hanging. */
async function exitedWithin(child: Child): Promise<number> {
  const timeout = Symbol('timeout');
  const result = await Promise.race([
    child.exited,
    Bun.sleep(CHILD_TIMEOUT_MS).then(() => timeout),
  ]);
  if (result === timeout) await stuck(child, 'an exit', '');
  return result as number;
}

/** Reads stdout until `marker` shows up, bounded so a blocked child cannot hang us. */
async function readUntil(child: Child, marker: string): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const timeout = Symbol('timeout');
  let seen = '';
  try {
    while (!seen.includes(marker)) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(CHILD_TIMEOUT_MS).then(() => timeout),
      ]);
      if (next === timeout) await stuck(child, marker, seen);
      const chunk = next as ReadableStreamReadResult<Uint8Array>;
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    // Release the stream so the pipe closes even if we bailed out early.
    await reader.cancel().catch(() => {});
  }
  return seen;
}

test(
  'startup upgrades a legacy database and reclaims its free pages',
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-db-upgrade-'));
    const dbPath = path.join(dir, 'legacy.db');
    try {
      const legacy = new Database(dbPath);
      legacy.exec('CREATE TABLE filler (value TEXT)');
      const insert = legacy.query('INSERT INTO filler VALUES (?)');
      legacy.transaction(() => {
        for (let i = 0; i < 5_000; i++) insert.run('x'.repeat(1_000));
      })();
      legacy.exec('DELETE FROM filler');
      const bloatedBytes = statSync(dbPath).size;
      expect(
        (legacy.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum,
      ).toBe(0);
      legacy.close();

      const importDb = `await import(${JSON.stringify(new URL('./db.ts', import.meta.url).href)})`;
      await withChild(importDb, dbPath, async (child) => {
        const exitCode = await exitedWithin(child);
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      });

      const upgraded = new Database(dbPath, { readonly: true });
      expect(
        (upgraded.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum,
      ).toBe(2);
      expect(
        (upgraded.query('PRAGMA freelist_count').get() as { freelist_count: number })
          .freelist_count,
      ).toBe(0);
      upgraded.close();
      expect(statSync(dbPath).size).toBeLessThan(bloatedBytes / 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  'startup truncates a stale WAL after all migrations finish',
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-db-wal-'));
    const dbPath = path.join(dir, 'wal.db');
    let writer: Database | null = null;
    try {
      writer = new Database(dbPath);
      writer.exec(
        'PRAGMA auto_vacuum = INCREMENTAL; CREATE TABLE filler (value TEXT); PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;',
      );
      const insert = writer.query('INSERT INTO filler VALUES (?)');
      writer.transaction(() => {
        for (let i = 0; i < 1_000; i++) insert.run('x'.repeat(1_000));
      })();
      const walPath = `${dbPath}-wal`;
      expect(statSync(walPath).size).toBeGreaterThan(500_000);

      // The child must stay alive past its own startup so the truncated WAL is
      // observable while it still holds the database open. It is killed in
      // withChild's finally, so the sleep only bounds a worst-case orphan.
      const importDb =
        `await import(${JSON.stringify(new URL('./db.ts', import.meta.url).href)}); ` +
        `console.log('__READY__'); await Bun.sleep(${CHILD_TIMEOUT_MS})`;
      await withChild(importDb, dbPath, async (child) => {
        expect(await readUntil(child, '__READY__')).toContain('__READY__');
        expect(statSync(walPath).size).toBe(0);
      });
    } finally {
      writer?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

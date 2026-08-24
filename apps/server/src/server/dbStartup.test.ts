import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('startup upgrades a legacy database and reclaims its free pages', async () => {
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
    expect((legacy.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(
      0,
    );
    legacy.close();

    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `await import(${JSON.stringify(new URL('./db.ts', import.meta.url).href)})`,
      ],
      {
        env: { ...process.env, TETHER_DB_PATH: dbPath },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

    const upgraded = new Database(dbPath, { readonly: true });
    expect(
      (upgraded.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum,
    ).toBe(2);
    expect(
      (upgraded.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
    ).toBe(0);
    upgraded.close();
    expect(statSync(dbPath).size).toBeLessThan(bloatedBytes / 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup truncates a stale WAL after all migrations finish', async () => {
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

    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `await import(${JSON.stringify(new URL('./db.ts', import.meta.url).href)}); console.log('__READY__'); await Bun.sleep(60_000)`,
      ],
      {
        env: { ...process.env, TETHER_DB_PATH: dbPath },
        stdout: 'pipe',
        stderr: 'ignore',
      },
    );
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let stdout = '';
      while (!stdout.includes('__READY__')) {
        const next = await reader.read();
        if (next.done) break;
        stdout += decoder.decode(next.value, { stream: true });
      }
      expect(stdout).toContain('__READY__');
      expect(statSync(walPath).size).toBe(0);
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    writer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

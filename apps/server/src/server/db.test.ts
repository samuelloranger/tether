// Run: TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts
import {
  addTerminalLog,
  db,
  getLogs,
  getLogsNewest,
  getSession,
  listSessions,
  pruneLogs,
  renameSession,
  resetRunningSessions,
  upsertSession,
} from './db';

let pass = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL ${msg}`);
  pass++;
}

// Replay reads newest-first in bounded batches so a byte-budget cutoff stays lazy.
{
  upsertSession('term-replay-order', 'bash', 'running');
  for (const chunk of ['a', 'b', 'c', 'd', 'e']) addTerminalLog('term-replay-order', chunk);
  const logs = [...getLogsNewest('term-replay-order', 0, 2)];
  ok(
    logs.map((row) => row.chunk).join('') === 'edcba',
    'newest-first replay iterator preserves descending id order across batches',
  );
}

// Database startup enables page reclamation for future pruning.
{
  const mode = db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number };
  ok(mode.auto_vacuum === 2, `auto_vacuum is incremental, got ${mode.auto_vacuum}`);
}

// listSessions returns rows with last_output_at
{
  upsertSession('term-1', 'bash', 'running');
  addTerminalLog('term-1', 'hello');
  const rows = listSessions();
  const row = rows.find((r) => r.id === 'term-1');
  ok(!!row, 'listSessions includes term-1');
  ok(row!.last_output_at != null, 'term-1 has last_output_at after output');

  upsertSession('term-2', 'bash', 'running');
  const empty = listSessions().find((r) => r.id === 'term-2');
  ok(empty!.last_output_at == null, 'term-2 has null last_output_at with no output');
}

// last_output_at follows the newest inserted log, without scanning every timestamp.
{
  upsertSession('term-latest', 'bash', 'running');
  const olderId = addTerminalLog('term-latest', 'older');
  const newerId = addTerminalLog('term-latest', 'newer');
  db.query('UPDATE terminal_logs SET created_at = $at WHERE id = $id').run({
    $id: olderId,
    $at: '2099-01-01 00:00:00',
  });
  db.query('UPDATE terminal_logs SET created_at = $at WHERE id = $id').run({
    $id: newerId,
    $at: '2000-01-01 00:00:00',
  });
  const row = listSessions().find((session) => session.id === 'term-latest');
  ok(row?.last_output_at === '2000-01-01 00:00:00', 'last output comes from newest log id');
}

// pruneLogs keeps only the last `cap` rows for a session
{
  upsertSession('term-cap', 'bash', 'running');
  for (let i = 0; i < 50; i++) addTerminalLog('term-cap', `line ${i}`);
  pruneLogs('term-cap', 10);
  const logs = getLogs('term-cap', 0);
  ok(logs.length === 10, `prune keeps 10 rows, got ${logs.length}`);
  ok(logs[logs.length - 1].chunk === 'line 49', 'newest row retained');
  ok(logs[0].chunk === 'line 40', 'oldest retained is line 40');
}

// renameSession sets and clears the name
{
  upsertSession('term-rename', 'bash', 'running');
  renameSession('term-rename', 'my build');
  const named = listSessions().find((r) => r.id === 'term-rename');
  ok(named!.name === 'my build', 'name is set after rename');

  renameSession('term-rename', null);
  const cleared = listSessions().find((r) => r.id === 'term-rename');
  ok(cleared!.name == null, 'name is null after clearing');
}

// pruneLogs records the high-water mark of pruned ids
{
  upsertSession('term-wm', 'bash', 'running');
  for (let i = 0; i < 30; i++) addTerminalLog('term-wm', `w${i}`);
  const before = getLogs('term-wm', 0);
  pruneLogs('term-wm', 10);
  const after = getLogs('term-wm', 0);
  const sess = getSession('term-wm');
  ok(after.length === 10, 'watermark prune keeps 10 rows');
  ok(sess!.pruned_before === before[before.length - 11].id, 'pruned_before = highest pruned id');

  // pruning again with nothing to prune must not lower the watermark
  pruneLogs('term-wm', 10);
  ok(getSession('term-wm')!.pruned_before === sess!.pruned_before, 'watermark stable when no-op');
}

// pruneLogs enforces a byte cap even when the row cap is not reached
{
  upsertSession('term-bytes', 'bash', 'running');
  for (let i = 0; i < 10; i++) addTerminalLog('term-bytes', 'x'.repeat(1000));
  pruneLogs('term-bytes', 1000, 3500);
  const logs = getLogs('term-bytes', 0);
  const bytes = logs.reduce((sum, row) => sum + row.chunk.length, 0);
  ok(logs.length === 3, `byte cap keeps 3 rows, got ${logs.length}`);
  ok(bytes <= 3500, `retained bytes ${bytes} within cap`);
  ok(getSession('term-bytes')!.pruned_before > 0, 'byte prune records the watermark');
}

// Byte caps count UTF-8 octets, not Unicode code points or UTF-16 code units.
{
  upsertSession('term-unicode-bytes', 'bash', 'running');
  addTerminalLog('term-unicode-bytes', '🚀');
  addTerminalLog('term-unicode-bytes', '中');
  pruneLogs('term-unicode-bytes', 1000, 5);
  const logs = getLogs('term-unicode-bytes', 0);
  const bytes = logs.reduce((sum, row) => sum + Buffer.byteLength(row.chunk), 0);
  ok(logs.length === 1, `UTF-8 byte cap keeps one 4-byte row, got ${logs.length}`);
  ok(bytes === 3, `retained UTF-8 bytes are measured exactly, got ${bytes}`);
}

// pruneLogs never drops the newest row, even if it alone exceeds the byte cap
{
  upsertSession('term-huge', 'bash', 'running');
  addTerminalLog('term-huge', 'old');
  addTerminalLog('term-huge', 'y'.repeat(5000));
  pruneLogs('term-huge', 1000, 100);
  const logs = getLogs('term-huge', 0);
  ok(logs.length === 1, `oversized newest row retained alone, got ${logs.length}`);
  ok(logs[0].chunk.length === 5000, 'the retained row is the newest one');
}

// Pruning returns freed pages to the filesystem instead of growing forever.
{
  upsertSession('term-reclaim', 'bash', 'running');
  for (let i = 0; i < 100; i++) addTerminalLog('term-reclaim', 'z'.repeat(20_000));
  const before = db.query('PRAGMA page_count').get() as { page_count: number };
  pruneLogs('term-reclaim', 1000, 100_000);
  const after = db.query('PRAGMA page_count').get() as { page_count: number };
  ok(after.page_count < before.page_count, 'incremental vacuum shrinks the database after prune');
}

// resetRunningSessions marks every running session stopped
{
  upsertSession('term-orphan', 'bash', 'running');
  resetRunningSessions();
  const row = listSessions().find((r) => r.id === 'term-orphan');
  ok(row!.status === 'stopped', 'orphan reset marks running sessions stopped');
}

{
  upsertSession('term-root', 'bash', 'running', '/tmp/tether-workspace');
  ok(
    getSession('term-root')!.workspace_root === '/tmp/tether-workspace',
    'new session stores workspace root',
  );
  upsertSession('term-root', 'zsh', 'stopped', '/tmp/other-workspace');
  const session = getSession('term-root')!;
  ok(session.workspace_root === '/tmp/tether-workspace', 'workspace root is immutable');
  ok(
    session.command === 'zsh' && session.status === 'stopped',
    'other session fields still update',
  );
}

console.log(`\n  ${pass} assertions passed\n`);

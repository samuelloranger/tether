// Run: TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts
import {
  addTerminalLog,
  db,
  getLogs,
  getSession,
  listSessions,
  pruneLogs,
  renameSession,
  resetRunningSessions,
  upsertSession,
} from './db';
import { getReplayLogs } from './replayRead';

let pass = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL ${msg}`);
  pass++;
}

// Replay materializes only the selected byte-bounded suffix of large chunks.
{
  upsertSession('term-replay-budget', 'bash', 'running');
  for (let i = 0; i < 250; i++) addTerminalLog('term-replay-budget', `${i}`.padEnd(10_000, 'x'));
  const replay = getReplayLogs('term-replay-budget', 0, 20_000);
  ok(replay.reset, 'bounded replay resets when older rows are excluded');
  ok(replay.logs.length === 2, `bounded replay fetches only 2 rows, got ${replay.logs.length}`);
  ok(replay.bytes === 20_000, `bounded replay reports 20000 UTF-8 bytes, got ${replay.bytes}`);
  ok(replay.logs[1].chunk.startsWith('249'), 'bounded replay retains the newest row');
}

// Under budget, replay skips the metadata pass and still reports UTF-8 bytes.
{
  upsertSession('term-replay-fast', 'bash', 'running');
  addTerminalLog('term-replay-fast', 'hello');
  addTerminalLog('term-replay-fast', '🚀');
  const all = getReplayLogs('term-replay-fast', 0, 1_000_000);
  ok(!all.reset, 'under-budget replay never asks for a reset');
  ok(all.logs.length === 2, `under-budget replay returns both rows, got ${all.logs.length}`);
  ok(all.bytes === 9, `under-budget replay reports 9 UTF-8 bytes, got ${all.bytes}`);
  // The fast path must still honour sinceId rather than replaying from scratch.
  const since = getReplayLogs('term-replay-fast', all.logs[0].id, 1_000_000);
  ok(since.logs.length === 1, `under-budget replay honours sinceId, got ${since.logs.length}`);
  ok(since.logs[0].chunk === '🚀', 'under-budget replay resumes after sinceId');
  ok(since.bytes === 4, `under-budget replay reports 4 UTF-8 bytes, got ${since.bytes}`);
}

// Replay selection also treats multibyte output as UTF-8 octets in SQL metadata.
{
  upsertSession('term-replay-unicode', 'bash', 'running');
  addTerminalLog('term-replay-unicode', '🚀🚀');
  addTerminalLog('term-replay-unicode', '中');
  const replay = getReplayLogs('term-replay-unicode', 0, 5);
  ok(replay.logs.length === 1, `Unicode replay keeps one row, got ${replay.logs.length}`);
  ok(replay.logs[0].chunk === '中', 'Unicode replay keeps the newest fitting row');
  ok(replay.bytes === 3, `Unicode replay measures 3 bytes, got ${replay.bytes}`);
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

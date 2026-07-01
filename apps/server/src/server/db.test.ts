// Run: TETHER_DB_PATH=/tmp/tether-test-$$.db bun run src/server/db.test.ts
import {
  addTerminalLog,
  getLogs,
  listSessions,
  pruneLogs,
  renameSession,
  upsertSession,
} from './db';

let pass = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL ${msg}`);
  pass++;
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

console.log(`\n  ${pass} assertions passed\n`);

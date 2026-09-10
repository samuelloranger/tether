import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { SPAWN_TIMEOUT_MS } from './spawnWindow';

test('SPAWN_TIMEOUT_MS is a finite liveness bound', () => {
  expect(Number.isFinite(SPAWN_TIMEOUT_MS)).toBe(true);
  expect(SPAWN_TIMEOUT_MS).toBeGreaterThan(0);
});

// The load-bearing assumption behind every spawnSync deadline in this server,
// pinned because the whole server-windows hang was one unbounded spawnSync: a
// blocking call owns the JS thread, so bun:test's per-test timeout — a timer on
// the event loop it is blocking — cannot end it. `timeout` is the only ceiling,
// and it comes from node:child_process because Bun.spawnSync has no equivalent.
// If a bun upgrade ever stopped honouring it, the hang would come back silently
// and every raised test timeout would again be treated as the fix. Uses its own
// short deadline rather than SPAWN_TIMEOUT_MS so the test costs ~1s, not 60.
test('spawnSync honours its timeout and kills the child', () => {
  const sleeper =
    process.platform === 'win32'
      ? ([
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'],
        ] as const)
      : (['sh', ['-c', 'sleep 30']] as const);

  const started = Date.now();
  const proc = spawnSync(sleeper[0], [...sleeper[1]], {
    encoding: 'utf8',
    timeout: 1_000,
    windowsHide: true,
  });
  const elapsed = Date.now() - started;

  // Killed, not awaited: a 30s sleeper cannot report a clean exit here.
  expect(proc.status).not.toBe(0);
  expect(elapsed).toBeLessThan(15_000);
});

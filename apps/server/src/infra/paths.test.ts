import { describe, expect, test } from 'bun:test';
import path from 'node:path';

// paths.ts reads env at module load, so each case needs its own module
// instance. A cache-busting query gives one without touching process.env
// for the whole suite.
let n = 0;
async function loadPaths(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return (await import(`./paths.ts?case=${n++}`)) as typeof import('./paths');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('CONTROL_SOCK', () => {
  test('follows TETHER_DB_PATH into the config dir', async () => {
    const db = '/tmp/tether-paths-test/sub/tether.db';
    const paths = await loadPaths({ TETHER_DB_PATH: db, TETHER_CONTROL_SOCK: undefined });
    // The e2e suite spawns several servers at once and isolates them with
    // TETHER_DB_PATH alone; a shared control socket makes the second one exit
    // at startup now that prepareControlSocket refuses a live path.
    expect(paths.CONTROL_SOCK).toBe(path.join(path.dirname(db), 'control.sock'));
    expect(paths.CONTROL_SOCK).toBe(path.join(paths.CONFIG_DIR, 'control.sock'));
  });

  test('TETHER_CONTROL_SOCK still wins outright', async () => {
    const paths = await loadPaths({
      TETHER_DB_PATH: '/tmp/tether-paths-test/tether.db',
      TETHER_CONTROL_SOCK: '/tmp/tether-paths-test/explicit.sock',
    });
    expect(paths.CONTROL_SOCK).toBe('/tmp/tether-paths-test/explicit.sock');
  });

  test('a source run keeps it beside the repo-local DB, never in ~/.tether', async () => {
    const paths = await loadPaths({ TETHER_DB_PATH: undefined, TETHER_CONTROL_SOCK: undefined });
    // COMPILED is false under the test runner, so this is the dev-run branch.
    expect(paths.CONTROL_SOCK).toBe(path.join(paths.CONFIG_DIR, 'control.sock'));
    expect(paths.CONTROL_SOCK).not.toBe(path.join(paths.STATE_DIR, 'control.sock'));
  });
});

import { describe, expect, test } from 'bun:test';
import { getSession, upsertSession } from './db';
import { SessionExitedError, startSession } from './pty';

const IS_WINDOWS = process.platform === 'win32';

describe('startSession exit guard', () => {
  test('does not resurrect a session that exited on its own', async () => {
    // A shell that ran and exited (e.g. while the client was backgrounded and
    // missed the exit frame) leaves the row 'stopped' and no live holder. The
    // guard throws before any spawn, so this stays portable (no shell runs).
    upsertSession('gone-1', '/bin/sh', 'stopped');

    await expect(startSession('gone-1')).rejects.toBeInstanceOf(SessionExitedError);

    // The stale `start` must NOT flip it back to running or spawn a new shell.
    expect(getSession('gone-1')?.status).toBe('stopped');
  });

  // Spawns a real holder, so gate it to where /bin/sh exists.
  test.skipIf(IS_WINDOWS)('a brand-new id still starts normally', async () => {
    const inst = await startSession('fresh-1', '/bin/sh');
    expect(inst).toBeDefined();
    expect(getSession('fresh-1')?.status).toBe('running');
  });
});

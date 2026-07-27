import { expect, test } from 'bun:test';
import { getSession, listSessions } from './db';
import { killSession, startSession } from './pty';

// Regression: the holder answers `{t:'k'}` with a `{t:'x'}` exit frame shortly
// after killSession returns. That handler used to re-`upsertSession` the row
// killSession had just deleted, so a closed tab reappeared in the drawer as
// 'stopped' and only a second kill made it stick.
test('a killed session stays gone once the holder reports its exit', async () => {
  const id = 'kill-stays-dead';
  await startSession(id, 'bash');
  expect(getSession(id)).toBeTruthy();

  killSession(id);
  expect(getSession(id)).toBeNull();

  // Give the holder time to notice the kill and send its exit frame.
  await Bun.sleep(1_000);

  expect(getSession(id)).toBeNull();
  expect(listSessions().some((row) => row.id === id)).toBe(false);
});

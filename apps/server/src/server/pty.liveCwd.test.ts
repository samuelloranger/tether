import { expect, test } from 'bun:test';
import { getLiveCwd, recordChunk } from './liveCwd';
import { killSession } from './pty';

test('killing a session clears its live cwd without waiting for a PTY exit frame', () => {
  const id = 'kill-clears-live-cwd';
  recordChunk(id, '\x1b]7;file://host/tmp/old-workspace\x07');

  killSession(id);

  expect(getLiveCwd(id)).toBeNull();
});

import { expect, test } from 'bun:test';
import { PTY_TEST_TIMEOUT_MS, SHELL_TIMEOUT_MS, TEST_SHELL, titleLine } from '../../test-shell';
import {
  killSession,
  type Subscriber,
  startSession,
  subscribeToSession,
  writeToSession,
} from './pty';
import { getOscTitle, recordTitleChunk } from './sessionTitle';

async function waitFor(condition: () => boolean, timeout = SHELL_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  expect(condition()).toBe(true);
}

test('killing a session clears its OSC title', () => {
  const id = 'kill-clears-title';
  recordTitleChunk(id, '\x1b]2;stale\x07');

  killSession(id);

  expect(getOscTitle(id)).toBeNull();
});

// Driven through the platform's real default shell rather than a hardcoded
// bash. On Windows the server spawns PowerShell, so bash here asserted about a
// shell no Windows session ever runs — and routed the escape through Git for
// Windows' MSYS pty instead of ConPTY, which is the layer that actually has to
// forward the title change.
test(
  'broadcasts a title frame when the shell emits OSC 0/2',
  async () => {
    const id = 'title-frames';
    const frames: Parameters<Subscriber>[0][] = [];
    let unsubscribe = () => {};
    try {
      await startSession(id, TEST_SHELL);
      unsubscribe = subscribeToSession(id, (frame) => frames.push(frame), 80, 24);

      writeToSession(id, titleLine('my fancy title'));

      await waitFor(() => frames.some((f) => f.type === 'title' && f.title === 'my fancy title'));
      expect(getOscTitle(id)).toBe('my fancy title');
    } finally {
      unsubscribe();
      killSession(id);
    }
  },
  PTY_TEST_TIMEOUT_MS,
);

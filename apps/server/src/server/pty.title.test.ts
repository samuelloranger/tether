import { expect, test } from 'bun:test';
import {
  killSession,
  type Subscriber,
  startSession,
  subscribeToSession,
  writeToSession,
} from './pty';
import { getOscTitle, recordTitleChunk } from './sessionTitle';

async function waitFor(condition: () => boolean, timeout = 3_000) {
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

test('broadcasts a title frame when the shell emits OSC 0/2', async () => {
  const id = 'title-frames';
  const frames: Parameters<Subscriber>[0][] = [];
  let unsubscribe = () => {};
  try {
    await startSession(id, 'bash');
    unsubscribe = subscribeToSession(id, (frame) => frames.push(frame), 80, 24);

    writeToSession(id, "printf '\\033]2;my fancy title\\007'\n");

    await waitFor(() => frames.some((f) => f.type === 'title' && f.title === 'my fancy title'));
    expect(getOscTitle(id)).toBe('my fancy title');
  } finally {
    unsubscribe();
    killSession(id);
  }
});

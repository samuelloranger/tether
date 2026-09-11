import { expect, test } from 'bun:test';
import { controlApp } from './controlApp';
import { clearActivity, getActivity } from './sessionActivity';

async function post(body: unknown): Promise<Response> {
  return controlApp.request('/control/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('rejects a state it does not model', async () => {
  expect((await post({ sessionId: 'sig-1', state: 'idle' })).status).toBe(400);
});

test('rejects a missing sessionId', async () => {
  expect((await post({ state: 'done' })).status).toBe(400);
});

test('refuses an unknown session rather than inventing state for it', async () => {
  clearActivity('sig-nope');
  const res = await post({ sessionId: 'sig-nope', state: 'done' });
  expect(res.status).toBe(404);
  // The important half: a typo must not leave a permanent entry behind.
  expect(getActivity('sig-nope')).toBeNull();
});

import { expect, test } from 'bun:test';
import { app, presentationControlToken } from './app';
import { clearActivity, getActivity } from './sessionActivity';

async function post(body: unknown, token?: string): Promise<Response> {
  return app.request('/control/signal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Tether-Present-Control': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('rejects a request with no control token', async () => {
  expect((await post({ sessionId: 'sig-1', state: 'done' })).status).toBe(401);
});

test('rejects a state it does not model', async () => {
  const res = await post({ sessionId: 'sig-1', state: 'idle' }, presentationControlToken);
  expect(res.status).toBe(400);
});

test('rejects a missing sessionId', async () => {
  expect((await post({ state: 'done' }, presentationControlToken)).status).toBe(400);
});

test('refuses an unknown session rather than inventing state for it', async () => {
  clearActivity('sig-nope');
  const res = await post({ sessionId: 'sig-nope', state: 'done' }, presentationControlToken);
  expect(res.status).toBe(404);
  // The important half: a typo must not leave a permanent entry behind.
  expect(getActivity('sig-nope')).toBeNull();
});

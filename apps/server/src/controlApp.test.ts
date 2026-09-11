import { describe, expect, test } from 'bun:test';
import { controlApp } from './controlApp';

const post = (path: string, body: unknown) =>
  controlApp.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('controlApp (ungated — the socket is the auth)', () => {
  test('rejects a bad presentation entry with 400, not 401', async () => {
    // No token header is sent; a 401 would mean a token gate is still wired.
    const res = await post('/control/presentations', { entry: '/nope/not-html.txt' });
    expect(res.status).toBe(400);
  });

  test('signal for an unknown session is 404, not 401', async () => {
    const res = await post('/control/signal', { sessionId: 'ghost', state: 'working' });
    expect(res.status).toBe(404);
  });

  test('pair/open succeeds with no token header', async () => {
    const res = await post('/control/pair/open', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string };
    expect(body.code).toMatch(/^[0-9A-Z]{12}$/);
    await post('/control/pair/close', {});
  });
});

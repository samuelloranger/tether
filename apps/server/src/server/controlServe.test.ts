import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './app';
import { serveControl } from './controlServe';

const sock = path.join(mkdtempSync(path.join(tmpdir(), 'tether-ctl-')), 'control.sock');
const server = serveControl(sock);
afterAll(() => server.stop(true));

const overSocket = (p: string) =>
  fetch(`http://localhost${p}`, {
    unix: sock,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  } as RequestInit);

describe('control socket', () => {
  test('serves /control/pair/open over the unix socket', async () => {
    const res = await overSocket('/control/pair/open');
    expect(res.status).toBe(200);
    await overSocket('/control/pair/close');
  });

  test('the network app no longer answers /control/*', async () => {
    const res = await app.request('/control/pair/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  test('the network app still answers /api/presentations (authless call is 401, not 404)', async () => {
    // Route exists (gated by authMiddleware) → 401. A 404 would mean we unmounted too much.
    const res = await app.request('/api/presentations');
    expect(res.status).toBe(401);
  });
});

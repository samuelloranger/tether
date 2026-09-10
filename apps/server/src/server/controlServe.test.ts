import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './app';
import { serveControl } from './controlServe';

// Bound to a hook, not module scope. Module-level work runs before bun has a
// test to attribute it to, so setDefaultTimeout cannot interrupt it: binding
// the unix socket up there meant a stall had no ceiling short of the CI step's
// own timeout, which then stranded every file still queued behind this one on
// the same --parallel worker. In a hook it fails in seconds, and names itself.
let sock: string;
let server: ReturnType<typeof serveControl>;

beforeAll(() => {
  sock = path.join(mkdtempSync(path.join(tmpdir(), 'tether-ctl-')), 'control.sock');
  server = serveControl(sock);
});
afterAll(() => server?.stop(true));

// Every request carries its own deadline. An unreachable unix socket makes
// fetch wait indefinitely by default, which is a hang rather than a failure.
const overSocket = (p: string) =>
  fetch(`http://localhost${p}`, {
    unix: sock,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
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

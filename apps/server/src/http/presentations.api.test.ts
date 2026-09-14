import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addDevice } from '@/auth/deviceRegistry';
import { mintToken } from '@/auth/deviceToken';
import { controlApp } from '@/control/app';
import { app } from './app';

// The control app (socket) creates the preview; the network app serves its
// self-contained HTML over the authed content route. They share one registry.
const create = (body: unknown) =>
  controlApp.request('/control/presentations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const reset = (project: string) =>
  controlApp.request('/control/presentations/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  });

const device = addDevice({ label: 'test', pubkey: 'a'.repeat(64) });
const bearer = { Authorization: `Bearer ${mintToken(device.id)}` };

test('serves inlined, self-contained HTML over the authed content route', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-api-'));
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, '<link rel="stylesheet" href="style.css">');
    writeFileSync(path.join(root, 'style.css'), 'body { color: papayawhip; }');

    const opened = await create({ entry, project: 'creneau', title: 'UI preview' });
    expect(opened.status).toBe(200);
    const preview = (await opened.json()) as { id: string };
    expect(preview).not.toHaveProperty('url');

    const res = await app.request(`/api/presentations/${preview.id}/content`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('<style>body { color: papayawhip; }</style>');

    expect(await (await reset('creneau')).json()).toEqual({ cleared: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the content route requires a bearer and 404s an unknown id', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-auth-'));
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, '<h1>hi</h1>');
    const preview = (await (await create({ entry, project: 'authcheck' })).json()) as {
      id: string;
    };

    const noAuth = await app.request(`/api/presentations/${preview.id}/content`);
    expect(noAuth.status).toBe(401);

    const missing = await app.request('/api/presentations/nope/content', { headers: bearer });
    expect(missing.status).toBe(404);

    await reset('authcheck');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('associates a preview with the sessionId it was opened with', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-session-'));
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, 'ok');

    const opened = await create({ entry, project: 'sessioned', sessionId: 'term-3' });
    const preview = (await opened.json()) as { sessionId?: string };
    expect(preview.sessionId).toBe('term-3');

    await reset('sessioned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './app';
import { controlApp } from './controlApp';

// The control app (socket) creates the preview; the network app (/preview)
// serves it. They share one PresentationRegistry, so a URL minted on one is
// resolvable on the other.
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

test('opens a scoped preview through control and serves its assets by capability URL', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-api-'));
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, '<link rel="stylesheet" href="style.css">');
    writeFileSync(path.join(root, 'style.css'), 'body { color: papayawhip; }');

    const opened = await create({ entry, project: 'creneau', title: 'UI preview' });
    expect(opened.status).toBe(200);
    const preview = (await opened.json()) as { url: string };
    expect(preview.url).toMatch(/^\/preview\/[a-f0-9]+\/index.html$/);

    const css = await app.request(preview.url.replace('index.html', 'style.css'));
    expect(css.status).toBe(200);
    expect(css.headers.get('Content-Type')).toContain('text/css');
    expect(await css.text()).toBe('body { color: papayawhip; }');

    expect(await (await reset('creneau')).json()).toEqual({ cleared: 1 });
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

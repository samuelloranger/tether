import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, presentationControlToken } from './app';

test('opens a scoped preview through local control and serves its assets by capability URL', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-api-'));
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, '<link rel="stylesheet" href="style.css">');
    writeFileSync(path.join(root, 'style.css'), 'body { color: papayawhip; }');

    const rejected = await app.request('/control/presentations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry }),
    });
    expect(rejected.status).toBe(401);

    const opened = await app.request('/control/presentations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tether-Present-Control': presentationControlToken,
      },
      body: JSON.stringify({ entry, project: 'creneau', title: 'UI preview' }),
    });
    expect(opened.status).toBe(200);
    const preview = (await opened.json()) as { url: string };
    expect(preview.url).toMatch(/^\/preview\/[a-f0-9]+\/index.html$/);

    const css = await app.request(preview.url.replace('index.html', 'style.css'));
    expect(css.status).toBe(200);
    expect(css.headers.get('Content-Type')).toContain('text/css');
    expect(await css.text()).toBe('body { color: papayawhip; }');

    const reset = await app.request('/control/presentations/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tether-Present-Control': presentationControlToken,
      },
      body: JSON.stringify({ project: 'creneau' }),
    });
    expect(await reset.json()).toEqual({ cleared: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('associates a preview with the sessionId it was opened with', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-preview-session-'));
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, 'ok');

    const opened = await app.request('/control/presentations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tether-Present-Control': presentationControlToken,
      },
      body: JSON.stringify({ entry, project: 'sessioned', sessionId: 'term-3' }),
    });
    const preview = (await opened.json()) as { sessionId?: string };
    expect(preview.sessionId).toBe('term-3');

    await app.request('/control/presentations/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tether-Present-Control': presentationControlToken,
      },
      body: JSON.stringify({ project: 'sessioned' }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

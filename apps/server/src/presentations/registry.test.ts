import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PresentationRegistry } from './registry';

function tempDir(prefix: string) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('registers an HTML preview without exposing its filesystem root or a URL', () => {
  const root = tempDir('tether-preview-');
  try {
    writeFileSync(path.join(root, 'index.html'), '<h1>Preview</h1>');
    const registry = new PresentationRegistry(10);
    const preview = registry.create({ entry: path.join(root, 'index.html'), title: 'Creneau UI' });

    expect(preview).toMatchObject({
      title: 'Creneau UI',
      project: path.basename(root),
      revision: 0,
    });
    expect(preview).not.toHaveProperty('url');
    expect(JSON.stringify(preview)).not.toContain(root);
    registry.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serves the inlined, self-contained HTML content by id', () => {
  const root = tempDir('tether-preview-');
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(path.join(root, 'logo.png'), png);
    writeFileSync(path.join(root, 'index.html'), '<img src="./logo.png">');
    const registry = new PresentationRegistry(10);
    const preview = registry.create({ entry: path.join(root, 'index.html') });

    const content = registry.content(preview.id);
    expect(content).toContain(`data:image/png;base64,${png.toString('base64')}`);
    expect(registry.content('nope')).toBeNull();
    registry.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('associates a preview with the session that created it, and allows none', () => {
  const root = tempDir('tether-preview-');
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, 'ok');
    const registry = new PresentationRegistry(10);

    const withSession = registry.create({ entry, sessionId: 'term-2' });
    expect(withSession.sessionId).toBe('term-2');

    const withoutSession = registry.create({ entry });
    expect(withoutSession.sessionId).toBeUndefined();

    registry.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('debounces changes, bumps revision, and regenerates content', async () => {
  const root = tempDir('tether-preview-');
  try {
    const entry = path.join(root, 'index.html');
    const css = path.join(root, 'style.css');
    writeFileSync(entry, '<link rel="stylesheet" href="style.css">');
    writeFileSync(css, 'body{color:blue}');
    const registry = new PresentationRegistry(10);
    const first = registry.create({ entry, project: 'creneau' });
    registry.create({ entry, project: 'creneau', title: 'Second' });
    expect(registry.content(first.id)).toContain('body{color:blue}');

    writeFileSync(css, 'body{color:red}');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(registry.list().find((preview) => preview.id === first.id)?.revision).toBe(1);
    expect(registry.content(first.id)).toContain('body{color:red}');
    expect(registry.reset('creneau')).toBe(2);
    expect(registry.list()).toEqual([]);
    registry.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

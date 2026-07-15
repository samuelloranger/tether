import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createControlToken, PresentationRegistry, resolvePresentationFile } from './presentations';

function tempDir(prefix: string) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('registers an HTML preview without exposing its filesystem root', () => {
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
    expect(preview.url).toMatch(/^\/preview\/[a-f0-9]+\/index\.html$/);
    expect(JSON.stringify(preview)).not.toContain(root);
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

test('rejects traversal and symlinks that escape a preview root', () => {
  const root = tempDir('tether-preview-');
  const outside = tempDir('tether-outside-');
  try {
    writeFileSync(path.join(root, 'index.html'), 'ok');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));

    expect(() => resolvePresentationFile(root, '../secret.txt')).toThrow(
      'preview path escapes its root',
    );
    expect(() => resolvePresentationFile(root, 'escape.txt')).toThrow(
      'preview path escapes its root',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('rejects a bare directory request instead of serving the root', () => {
  const root = tempDir('tether-preview-');
  try {
    writeFileSync(path.join(root, 'index.html'), 'ok');
    mkdirSync(path.join(root, 'assets'));

    expect(() => resolvePresentationFile(root, '')).toThrow('preview path is a directory');
    expect(() => resolvePresentationFile(root, 'assets')).toThrow('preview path is a directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('debounces changes and resets all previews for a project', async () => {
  const root = tempDir('tether-preview-');
  try {
    const entry = path.join(root, 'index.html');
    const css = path.join(root, 'style.css');
    writeFileSync(entry, 'ok');
    writeFileSync(css, 'body{}');
    const registry = new PresentationRegistry(10);
    const first = registry.create({ entry, project: 'creneau' });
    registry.create({ entry, project: 'creneau', title: 'Second' });

    writeFileSync(css, 'body{color:red}');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(registry.list().find((preview) => preview.id === first.id)?.revision).toBe(1);
    expect(registry.reset('creneau')).toBe(2);
    expect(registry.list()).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('creates and reuses an owner-only local control token', () => {
  const root = tempDir('tether-control-');
  try {
    const file = path.join(root, 'present-control-token');
    const first = createControlToken(file);
    const second = createControlToken(file);

    expect(first).toMatch(/^[a-f0-9]{48}$/);
    expect(second).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

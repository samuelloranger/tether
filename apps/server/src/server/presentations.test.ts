import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAN_SYMLINK } from '../../test-paths';
import { PresentationRegistry, resolvePresentationFile } from './presentations';

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

// Needs a symlink fixture, which a default Windows install refuses to create.
test.skipIf(!CAN_SYMLINK)('rejects traversal and symlinks that escape a preview root', () => {
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

test('a preview token expires after its TTL and is then unresolvable', () => {
  const root = tempDir('tether-ttl-');
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, 'ok');
    let clock = 1_000;
    const registry = new PresentationRegistry(150, 60_000, () => clock);
    const { url } = registry.create({ entry });
    const token = url.split('/')[2];

    expect(registry.findByToken(token)).not.toBeNull();
    clock += 60_001; // just past the TTL
    expect(registry.findByToken(token)).toBeNull();
    registry.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listing (the authed poll) renews a preview and keeps its token stable', () => {
  const root = tempDir('tether-renew-');
  try {
    const entry = path.join(root, 'index.html');
    writeFileSync(entry, 'ok');
    let clock = 1_000;
    const registry = new PresentationRegistry(150, 60_000, () => clock);
    const { url } = registry.create({ entry });
    const token = url.split('/')[2];

    clock += 40_000;
    const listed = registry.list(); // renews expiry
    expect(listed[0]?.url).toBe(url); // same token string → no iframe reload churn

    clock += 40_000; // 80s since create, but only 40s since the renewing list
    expect(registry.findByToken(token)).not.toBeNull();
    registry.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

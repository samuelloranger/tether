import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from '../app';
import { testAuthHeaders } from '../testAuth';

test('GET /api/fs/dirs lists subdirectories of a temp dir, ignoring files and dotfiles', async () => {
  const AUTH = testAuthHeaders();
  const root = mkdtempSync(path.join(os.tmpdir(), 'tether-fs-test-'));
  try {
    mkdirSync(path.join(root, 'alpha'));
    mkdirSync(path.join(root, 'beta'));
    mkdirSync(path.join(root, '.hidden'));
    writeFileSync(path.join(root, 'a-file.txt'), 'x');

    const res = await app.request(`/api/fs/dirs?path=${encodeURIComponent(root)}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      parent: string | null;
      dirs: { name: string; path: string }[];
    };
    expect(body.path).toBe(root);
    expect(body.parent).toBe(path.dirname(root));
    expect(body.dirs.map((d) => d.name)).toEqual(['alpha', 'beta']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/fs/dirs returns 400 for a missing path', async () => {
  const AUTH = testAuthHeaders();
  const missing = path.join(os.tmpdir(), 'tether-fs-test-does-not-exist');
  const res = await app.request(`/api/fs/dirs?path=${encodeURIComponent(missing)}`, {
    headers: AUTH,
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBeTruthy();
});

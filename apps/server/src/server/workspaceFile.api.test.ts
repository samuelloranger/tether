import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './app';
import { getAuthHash, setAuthHash, upsertSession } from './db';

const PASSWORD = 'test-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}` };

async function ensureAuth() {
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
}

test('GET /api/sessions/:id/file serves workspace text for an authenticated rooted session', async () => {
  const previousAuthHash = getAuthHash();
  await ensureAuth();
  const root = mkdtempSync(path.join(tmpdir(), 'tether-file-api-'));
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'main.ts'), 'export const answer = 42;\n');
    upsertSession('file-rooted', 'bash', 'running', root);

    const ok = await app.request(
      `/api/sessions/file-rooted/file?path=${encodeURIComponent('main.ts')}&cwd=${encodeURIComponent(path.join(root, 'src'))}`,
      { headers: AUTH },
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      path: 'src/main.ts',
      content: 'export const answer = 42;\n',
    });

    upsertSession('file-legacy', 'bash', 'running');
    const legacy = await app.request('/api/sessions/file-legacy/file?path=main.ts', {
      headers: AUTH,
    });
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toEqual({
      error: 'restart terminal to enable file viewing',
    });

    const bad = await app.request(
      `/api/sessions/file-rooted/file?path=${encodeURIComponent('../secret.txt')}`,
      { headers: AUTH },
    );
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('content');
    expect(body.error).toBeDefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
    setAuthHash(previousAuthHash);
  }
});

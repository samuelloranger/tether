import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './app';
import { getAuthHash, setAuthHash, upsertSession } from './db';
import { clearLiveCwd, recordChunk } from './liveCwd';

const PASSWORD = 'test-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}` };

async function ensureAuth() {
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
}

function osc7(root: string) {
  return `\x1b]7;file://host${root}\x07`;
}

test('GET /api/sessions/:id/file serves workspace text once the shell has reported its cwd', async () => {
  const previousAuthHash = getAuthHash();
  await ensureAuth();
  const root = mkdtempSync(path.join(tmpdir(), 'tether-file-api-'));
  try {
    execSync('git init -q', { cwd: root });
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'main.ts'), 'export const answer = 42;\n');
    upsertSession('file-rooted', 'bash', 'running');
    recordChunk('file-rooted', osc7(path.join(root, 'src')));

    const ok = await app.request(`/api/sessions/file-rooted/file?path=${encodeURIComponent('main.ts')}`, {
      headers: AUTH,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: 'src/main.ts', content: 'export const answer = 42;\n' });

    upsertSession('file-pending', 'bash', 'running');
    const pending = await app.request('/api/sessions/file-pending/file?path=main.ts', { headers: AUTH });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({ error: 'waiting for shell to report its working directory' });

    const bad = await app.request(
      `/api/sessions/file-rooted/file?path=${encodeURIComponent('../secret.txt')}`,
      { headers: AUTH },
    );
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('content');
    expect(body.error).toBeDefined();
  } finally {
    clearLiveCwd('file-rooted');
    clearLiveCwd('file-pending');
    rmSync(root, { recursive: true, force: true });
    setAuthHash(previousAuthHash);
  }
});

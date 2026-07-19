import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('diff routes summarize and return an in-progress change', async () => {
  const previousAuthHash = getAuthHash();
  await ensureAuth();
  const root = mkdtempSync(path.join(tmpdir(), 'tether-diff-api-'));
  try {
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
    execSync('git add main.ts && git commit -q -m initial', { cwd: root });
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');

    upsertSession('diff-session', 'bash', 'running');
    recordChunk('diff-session', osc7(root));

    const summary = await app.request('/api/sessions/diff-session/diff/summary', { headers: AUTH });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toEqual({
      files: [{ path: 'main.ts', insertions: 1, deletions: 1, binary: false }],
    });

    const diff = await app.request(
      `/api/sessions/diff-session/diff?path=${encodeURIComponent('main.ts')}`,
      {
        headers: AUTH,
      },
    );
    expect(diff.status).toBe(200);
    const body = (await diff.json()) as { diff: string; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.diff).toContain('+export const answer = 43;');

    upsertSession('diff-pending', 'bash', 'running');
    const pending = await app.request('/api/sessions/diff-pending/diff/summary', { headers: AUTH });
    expect(pending.status).toBe(409);
  } finally {
    clearLiveCwd('diff-session');
    clearLiveCwd('diff-pending');
    rmSync(root, { recursive: true, force: true });
    setAuthHash(previousAuthHash);
  }
});

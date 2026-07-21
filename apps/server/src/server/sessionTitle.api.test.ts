import { expect, test } from 'bun:test';
import { app } from './app';
import { deleteSession, getAuthHash, setAuthHash, upsertSession } from './db';
import { clearLiveCwd, reportCwd } from './liveCwd';
import { clearTitle, recordTitleChunk } from './sessionTitle';

const PASSWORD = 'test-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}` };

test('GET /api/sessions annotates rows with auto_title', async () => {
  const previousAuthHash = getAuthHash();
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
  upsertSession('tt-osc', 'bash', 'running');
  upsertSession('tt-cwd', 'bash', 'running');
  upsertSession('tt-bare', 'zsh', 'running');
  upsertSession('tt-stopped', 'fish', 'stopped');
  try {
    recordTitleChunk('tt-osc', '\x1b]2;claude — tether\x07');
    reportCwd('tt-osc', '/home/sam/sites/tether');
    reportCwd('tt-cwd', '/home/sam/sites/tether');
    // Stale live state for a stopped session must not leak into its title.
    recordTitleChunk('tt-stopped', '\x1b]2;stale\x07');

    const res = await app.request('/api/sessions', { headers: AUTH });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; auto_title: string }[];
    const byId = new Map(rows.map((r) => [r.id, r.auto_title]));
    expect(byId.get('tt-osc')).toBe('claude — tether');
    expect(byId.get('tt-cwd')).toBe('tether');
    expect(byId.get('tt-bare')).toBe('zsh');
    expect(byId.get('tt-stopped')).toBe('fish');
  } finally {
    for (const id of ['tt-osc', 'tt-cwd', 'tt-bare', 'tt-stopped']) {
      clearTitle(id);
      clearLiveCwd(id);
      deleteSession(id);
    }
    setAuthHash(previousAuthHash);
  }
});

import { expect, test } from 'bun:test';
import { app } from './app';
import { deleteSession, getAuthHash, setAuthHash, upsertSession } from './db';
import { clearActivity, recordOutput } from './sessionActivity';

const PASSWORD = 'test-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}` };

test('GET /api/sessions annotates rows with live activity', async () => {
  const previousAuthHash = getAuthHash();
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
  upsertSession('act-busy', 'bash', 'running');
  upsertSession('act-blocked', 'bash', 'running');
  upsertSession('act-unknown', 'bash', 'running');
  upsertSession('act-stopped', 'bash', 'stopped');
  try {
    recordOutput('act-busy', 'compiling…\n');
    recordOutput('act-blocked', 'Allow? \x07');

    const res = await app.request('/api/sessions', { headers: AUTH });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; activity: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r.activity]));
    expect(byId.get('act-busy')).toBe('working');
    expect(byId.get('act-blocked')).toBe('waiting');
    // No output seen yet (e.g. detached holder after a restart) → null.
    expect(byId.get('act-unknown')).toBeNull();
    // Stopped sessions never report activity, even with stale state.
    expect(byId.get('act-stopped')).toBeNull();
  } finally {
    for (const id of ['act-busy', 'act-blocked', 'act-unknown', 'act-stopped']) {
      clearActivity(id);
      deleteSession(id);
    }
    setAuthHash(previousAuthHash);
  }
});

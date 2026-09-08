import { expect, test } from 'bun:test';
import { app } from '../app';
import { createAgentSession, db, deleteSession } from '../db';
import { testAuthHeaders } from '../testAuth';

test('GET /api/sessions surfaces kind for agent sessions', async () => {
  const AUTH = testAuthHeaders();
  createAgentSession(db, { id: 'kind-agent', workspaceRoot: '/tmp/kind-agent' });
  try {
    const res = await app.request('/api/sessions', { headers: AUTH });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; kind: string }[];
    const row = rows.find((r) => r.id === 'kind-agent');
    expect(row?.kind).toBe('agent');
  } finally {
    deleteSession('kind-agent');
  }
});

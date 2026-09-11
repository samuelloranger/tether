import { expect, test } from 'bun:test';
import { sharedAgentRegistry } from '@/agent/registry';
import { createAgentSession, db, deleteSession, getSession } from '@/infra/db';
import { testAuthHeaders } from '@/testing/auth';
import { app } from '../app';

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

test('GET /api/sessions surfaces the workspace_root basename as auto_title for agent sessions', async () => {
  const AUTH = testAuthHeaders();
  createAgentSession(db, { id: 'kind-agent-title', workspaceRoot: '/home/u/sites/tether' });
  try {
    const res = await app.request('/api/sessions', { headers: AUTH });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; auto_title: string }[];
    const row = rows.find((r) => r.id === 'kind-agent-title');
    expect(row?.auto_title).toBe('tether');
  } finally {
    deleteSession('kind-agent-title');
  }
});

test('POST /api/sessions/kill on an agent session drops it from the shared registry + DB', async () => {
  const AUTH = testAuthHeaders();
  createAgentSession(db, { id: 'kind-agent-kill', workspaceRoot: '/tmp/kind-agent-kill' });
  try {
    const res = await app.request('/api/sessions/kill', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'kind-agent-kill' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sharedAgentRegistry.has('kind-agent-kill')).toBe(false);
    expect(getSession('kind-agent-kill')).toBeNull();
  } finally {
    deleteSession('kind-agent-kill');
  }
});

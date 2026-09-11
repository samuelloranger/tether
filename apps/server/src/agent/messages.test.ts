import { expect, test } from 'bun:test';
import { createAgentSession, db, deleteSession, getSession } from '@/infra/db';
import {
  appendAgentMessage,
  deleteAgentMessages,
  getAgentMessages,
  pruneAgentMessages,
} from './messages';

test('getAgentMessages returns rows ordered by seq, filtered by sinceSeq', () => {
  createAgentSession(db, { id: 'am1', workspaceRoot: '/tmp' });
  appendAgentMessage(db, { sessionId: 'am1', seq: 1, kind: 'delta', text: 'Hi there' });
  appendAgentMessage(db, {
    sessionId: 'am1',
    seq: 2,
    kind: 'tool',
    toolJson: JSON.stringify({ name: 'bash', input: { cmd: 'ls' } }),
  });
  appendAgentMessage(db, {
    sessionId: 'am1',
    seq: 3,
    kind: 'tool_result',
    text: 'a.txt',
    isError: false,
  });
  appendAgentMessage(db, {
    sessionId: 'am1',
    seq: 4,
    kind: 'done',
    toolJson: JSON.stringify({ cost: 0.01, usage: {} }),
  });

  const all = getAgentMessages(db, 'am1', 0);
  expect(all.map((r) => r.seq)).toEqual([1, 2, 3, 4]);

  const since = getAgentMessages(db, 'am1', 2);
  expect(since.map((r) => r.kind)).toEqual(['tool_result', 'done']);
});

test('appendAgentMessage upserts by (session_id, seq) — a re-flushed coalesced row overwrites, never duplicates', () => {
  createAgentSession(db, { id: 'am-upsert', workspaceRoot: '/tmp' });
  appendAgentMessage(db, { sessionId: 'am-upsert', seq: 1, kind: 'delta', text: 'Hi' });
  appendAgentMessage(db, { sessionId: 'am-upsert', seq: 1, kind: 'delta', text: 'Hi there' });

  const rows = getAgentMessages(db, 'am-upsert', 0);
  expect(rows).toHaveLength(1);
  expect(rows[0].text).toBe('Hi there');
});

test('deleteAgentMessages purges a session transcript', () => {
  createAgentSession(db, { id: 'am-del', workspaceRoot: '/tmp' });
  appendAgentMessage(db, { sessionId: 'am-del', seq: 1, kind: 'delta', text: 'x' });

  deleteAgentMessages('am-del');

  expect(getAgentMessages(db, 'am-del', 0)).toHaveLength(0);
});

// The agent kill route (routes/sessions.ts) calls deleteAgentMessages alongside
// deleteSession — deleteSession itself only owns terminal_logs + the row.
test('deleteAgentMessages + deleteSession together clear the transcript and the session row', () => {
  createAgentSession(db, { id: 'am-kill', workspaceRoot: '/tmp' });
  appendAgentMessage(db, { sessionId: 'am-kill', seq: 1, kind: 'delta', text: 'x' });

  deleteAgentMessages('am-kill');
  deleteSession('am-kill');

  expect(getAgentMessages(db, 'am-kill', 0)).toHaveLength(0);
  expect(getSession('am-kill')).toBeNull();
});

test('pruneAgentMessages caps retained rows to the newest N', () => {
  createAgentSession(db, { id: 'am-prune', workspaceRoot: '/tmp' });
  for (let i = 1; i <= 10; i++) {
    appendAgentMessage(db, { sessionId: 'am-prune', seq: i, kind: 'delta', text: `${i}` });
  }

  pruneAgentMessages(db, 'am-prune', 5);

  const rows = getAgentMessages(db, 'am-prune', 0);
  expect(rows).toHaveLength(5);
  expect(rows[0].seq).toBe(6); // oldest surviving row
});

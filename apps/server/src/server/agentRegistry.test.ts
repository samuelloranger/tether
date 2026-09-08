import { beforeEach, expect, test } from 'bun:test';
import type { AgentDriver, AgentEvent, AgentFrame } from './agentDriver';
import { FakeAgentDriver } from './agentDriver';
import type { AgentMessageInsert } from './agentMessages';
import { AgentRegistry } from './agentRegistry';
import { db } from './db';

// Tests using the default persist write rows to the shared per-process DB, and
// tests using the default seqSeed read MAX(seq) back from it — so without this,
// one test's `a1` rows shift another's seed and its `seq: 1` assertions fail
// (only in the full parallel suite, where both run against the same DB).
beforeEach(() => {
  db.query('DELETE FROM agent_messages').run();
});

/** Records close() calls, unlike FakeAgentDriver's no-op — used to verify killAll. */
class RecordingDriver implements AgentDriver {
  closed = false;
  async start(_cwd: string): Promise<void> {}
  async *prompt(_text: string): AsyncIterable<AgentEvent> {}
  interrupt(): void {}
  close(): void {
    this.closed = true;
  }
}

test('prompt fans mapped frames with monotonic seq to attached sink', async () => {
  const reg = new AgentRegistry(
    () =>
      new FakeAgentDriver([
        [
          { t: 'delta', text: 'Hi' },
          { t: 'done', cost: 0, usage: {} },
        ],
      ]),
  );
  await reg.start('a1', '/tmp');
  const got: AgentFrame[] = [];
  reg.attach('a1', (f) => got.push(f));
  await reg.prompt('a1', 'hello');
  // The echoed user prompt leads, seq 1, ahead of the reply it triggered.
  expect(got.map((f) => f.t)).toEqual(['agent.user', 'agent.delta', 'agent.done']);
  expect(got[0]).toEqual({ t: 'agent.user', seq: 1, text: 'hello' });
  expect((got[1] as { seq: number }).seq).toBe(2);
  expect((got[2] as { seq: number }).seq).toBe(3);
});

test('delta,delta,tool,done persists one coalesced delta row, then tool, then done — seq stays consistent with what was fanned live', async () => {
  const persisted: AgentMessageInsert[] = [];
  const reg = new AgentRegistry(
    () =>
      new FakeAgentDriver([
        [
          { t: 'delta', text: 'Hel' },
          { t: 'delta', text: 'lo' },
          { t: 'tool', name: 'bash', input: { cmd: 'ls' } },
          { t: 'done', cost: 0.02, usage: { in: 1, out: 2 } },
        ],
      ]),
    (row) => persisted.push(row),
  );
  await reg.start('a1', '/tmp');
  const got: AgentFrame[] = [];
  reg.attach('a1', (f) => got.push(f));
  await reg.prompt('a1', 'hi');

  // Live fan-out: the echoed user prompt, then every individual delta unbuffered.
  expect(got.map((f) => f.t)).toEqual([
    'agent.user',
    'agent.delta',
    'agent.delta',
    'agent.tool',
    'agent.done',
  ]);

  // The user prompt persists first (seq 1). Persistence coalesces the two deltas
  // into one row keyed by the FIRST delta's seq (2) — the same seq the client
  // saw live, so replay and live never disagree on ordering.
  expect(persisted).toEqual([
    { sessionId: 'a1', seq: 1, kind: 'user', text: 'hi' },
    { sessionId: 'a1', seq: 2, kind: 'delta', text: 'Hello' },
    {
      sessionId: 'a1',
      seq: 4,
      kind: 'tool',
      toolJson: JSON.stringify({ name: 'bash', input: { cmd: 'ls' } }),
    },
    {
      sessionId: 'a1',
      seq: 5,
      kind: 'done',
      toolJson: JSON.stringify({ cost: 0.02, usage: { in: 1, out: 2 } }),
    },
  ]);
});

test('a tool_result frame persists text + isError alongside its own seq', async () => {
  const persisted: AgentMessageInsert[] = [];
  const reg = new AgentRegistry(
    () =>
      new FakeAgentDriver([
        [
          { t: 'tool', name: 'bash', input: {} },
          { t: 'tool_result', text: 'boom', isError: true },
          { t: 'done', cost: 0, usage: {} },
        ],
      ]),
    (row) => persisted.push(row),
  );
  await reg.start('a2', '/tmp');
  await reg.prompt('a2', 'hi');

  // [0] user, [1] tool, [2] tool_result, [3] done.
  expect(persisted[2]).toEqual({
    sessionId: 'a2',
    seq: 3,
    kind: 'tool_result',
    text: 'boom',
    isError: true,
  });
});

test('start seeds FrameSeq from the persisted max so seqs continue across a restart', async () => {
  const got: AgentFrame[] = [];
  const reg = new AgentRegistry(
    () =>
      new FakeAgentDriver([
        [
          { t: 'delta', text: 'hi' },
          { t: 'done', cost: 0, usage: {} },
        ],
      ]),
    () => {}, // don't touch the DB
    () => 189, // pretend seq 1..189 are already persisted
  );
  await reg.start('a1', '/tmp');
  reg.attach('a1', (f) => got.push(f));
  await reg.prompt('a1', 'q');

  // Numbering resumes at 190, never colliding with the stored 1..189.
  expect(got.map((f) => (f as { seq: number }).seq)).toEqual([190, 191, 192]);
});

test('killAll closes every driver and clears the registry', async () => {
  const drivers: RecordingDriver[] = [];
  const reg = new AgentRegistry(() => {
    const d = new RecordingDriver();
    drivers.push(d);
    return d;
  });
  await reg.start('a1', '/tmp');
  await reg.start('a2', '/tmp');

  reg.killAll();

  expect(drivers.map((d) => d.closed)).toEqual([true, true]);
  expect(reg.has('a1')).toBe(false);
  expect(reg.has('a2')).toBe(false);
});

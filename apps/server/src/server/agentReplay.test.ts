import { expect, test } from 'bun:test';
import type { AgentDriver, AgentEvent } from './agentDriver';
import { AgentRegistry } from './agentRegistry';
import { applyAgentStart } from './agentReplay';
import { createAgentSession, db } from './db';
import type { AgentState } from './noiseSessionProtocol';

/** Captures the cwd a driver was started with, so we can assert what
 * applyAgentStart resolved for the `claude` spawn. */
class CwdCapturingDriver implements AgentDriver {
  startCwd: string | null = null;
  async start(cwd: string): Promise<void> {
    this.startCwd = cwd;
  }
  async *prompt(_text: string): AsyncIterable<AgentEvent> {}
  interrupt(): void {}
  close(): void {}
}

function makeAgentState(): { agent: AgentState; drivers: CwdCapturingDriver[] } {
  const drivers: CwdCapturingDriver[] = [];
  const registry = new AgentRegistry(() => {
    const d = new CwdCapturingDriver();
    drivers.push(d);
    return d;
  });
  return { agent: { registry, attachments: new Map(), currentId: null }, drivers };
}

const deps = { getAgentMessages: () => [] } as unknown as Parameters<typeof applyAgentStart>[1];

test('resumed chat respawns in the persisted workspace_root, not the client cwd', async () => {
  // First open recorded the real folder; a force-close + relaunch sends cwd:''.
  createAgentSession(db, { id: 'agent-resume', workspaceRoot: '/home/sam/sites/tether' });
  const { agent, drivers } = makeAgentState();

  await applyAgentStart(
    { t: 'agent.start', id: 'agent-resume', cwd: '', sinceSeq: 0 },
    deps,
    () => true,
    agent,
  );

  expect(drivers).toHaveLength(1);
  expect(drivers[0].startCwd).toBe('/home/sam/sites/tether');
});

test('brand-new chat with no row falls back to the client cwd', async () => {
  const { agent, drivers } = makeAgentState();

  await applyAgentStart(
    { t: 'agent.start', id: 'agent-fresh', cwd: '/home/sam/sites/vigie', sinceSeq: 0 },
    deps,
    () => true,
    agent,
  );

  expect(drivers[0].startCwd).toBe('/home/sam/sites/vigie');
});

import { expect, test } from 'bun:test';
import type { AgentFrame } from './agentDriver';
import { FakeAgentDriver } from './agentDriver';
import { AgentRegistry } from './agentRegistry';

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
  expect(got.map((f) => f.t)).toEqual(['agent.delta', 'agent.done']);
  expect((got[0] as { seq: number }).seq).toBe(1);
  expect((got[1] as { seq: number }).seq).toBe(2);
});

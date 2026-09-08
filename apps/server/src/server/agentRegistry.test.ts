import { expect, test } from 'bun:test';
import type { AgentDriver, AgentEvent, AgentFrame } from './agentDriver';
import { FakeAgentDriver } from './agentDriver';
import { AgentRegistry } from './agentRegistry';

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
  expect(got.map((f) => f.t)).toEqual(['agent.delta', 'agent.done']);
  expect((got[0] as { seq: number }).seq).toBe(1);
  expect((got[1] as { seq: number }).seq).toBe(2);
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

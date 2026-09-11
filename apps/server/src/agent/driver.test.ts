import { expect, test } from 'bun:test';
import { FakeAgentDriver } from './driver';

test('FakeAgentDriver yields the scripted events for a prompt', async () => {
  const driver = new FakeAgentDriver([
    [
      { t: 'delta', text: 'Hi' },
      { t: 'done', cost: 0.01, usage: {} },
    ],
  ]);
  await driver.start('/tmp');
  const seen: string[] = [];
  for await (const ev of driver.prompt('hello')) seen.push(ev.t);
  expect(seen).toEqual(['delta', 'done']);
});

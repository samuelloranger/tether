import { expect, test } from 'bun:test';
import { FrameSeq, toFrame } from './agentEventMap';

test('assigns increasing seq to delta, done, and error', () => {
  const seq = new FrameSeq();
  const a = toFrame({ t: 'delta', text: 'x' }, seq);
  const b = toFrame({ t: 'done', cost: 0, usage: {} }, seq);
  const e = toFrame({ t: 'error', message: 'boom' }, seq);
  expect(a).toEqual({ t: 'agent.delta', seq: 1, text: 'x' });
  expect(b).toEqual({ t: 'agent.done', seq: 2, cost: 0, usage: {} });
  expect(e).toEqual({ t: 'agent.error', seq: 3, message: 'boom' });
});

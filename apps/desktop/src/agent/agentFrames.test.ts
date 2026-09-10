import { describe, expect, test } from 'bun:test';
import { agentModel, agentPrompt, agentStart, decodeAgentFrame } from './agentFrames';

describe('decodeAgentFrame', () => {
  test('decodes a delta', () => {
    const f = decodeAgentFrame('{"t":"agent.delta","seq":3,"text":"hi"}');
    expect(f).toEqual({ t: 'agent.delta', seq: 3, text: 'hi' });
  });

  test('returns null for non-agent frames', () => {
    expect(decodeAgentFrame('{"t":"output","chunk":"x"}')).toBeNull();
  });

  test('returns null for garbage', () => {
    expect(decodeAgentFrame('not json')).toBeNull();
  });
});

describe('outbound builders', () => {
  test('start carries cwd + sinceSeq', () => {
    expect(agentStart({ id: 's1', cwd: '/tmp', sinceSeq: 4 })).toEqual({
      t: 'agent.start',
      id: 's1',
      cwd: '/tmp',
      sinceSeq: 4,
    });
  });

  test('prompt carries text', () => {
    expect(agentPrompt('go')).toEqual({ t: 'agent.prompt', text: 'go' });
  });
});

test('agentModel builds the model frame', () => {
  expect(agentModel('opus')).toEqual({ t: 'agent.model', name: 'opus' });
});

import { describe, expect, test } from 'bun:test';
import { nextAgentSessionId } from './newChat';

describe('nextAgentSessionId', () => {
  test('starts at agent-1 with no agent sessions', () => {
    expect(nextAgentSessionId(['term-1', 'term-2'])).toBe('agent-1');
  });

  test('increments past the highest agent-N', () => {
    expect(nextAgentSessionId(['agent-1', 'term-1', 'agent-3'])).toBe('agent-4');
  });

  test('ignores non-agent ids', () => {
    expect(nextAgentSessionId(['agentx', 'agent-'])).toBe('agent-1');
  });
});

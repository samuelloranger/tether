import { expect, test } from 'bun:test';
import type { AgentMessage } from './agentTypes';
import { transcriptText } from './transcriptText';

const msgs: AgentMessage[] = [
  { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi' }], isStreaming: false },
  {
    id: 'a1',
    role: 'assistant',
    blocks: [
      { type: 'text', text: 'hello' },
      {
        type: 'tool',
        tool: { id: 't', name: 'Bash', summary: 'ls', inputJson: '{}', isError: false },
      },
      { type: 'text', text: ' there' },
    ],
    isStreaming: false,
  },
];

test('mode "last" returns only the newest assistant text', () => {
  expect(transcriptText(msgs, 'last')).toBe('hello there');
});

test('default mode joins the whole transcript with role labels', () => {
  expect(transcriptText(msgs, 'all')).toBe('You: hi\n\nClaude: hello there');
});

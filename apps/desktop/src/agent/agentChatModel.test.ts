import { describe, expect, test } from 'bun:test';
import { AgentChatModel } from './agentChatModel';

describe('AgentChatModel core', () => {
  test('coalesces deltas into one streaming assistant message', () => {
    const m = new AgentChatModel();
    m.apply({ t: 'agent.delta', seq: 1, text: 'Hel' });
    m.apply({ t: 'agent.delta', seq: 2, text: 'lo' });
    const [msg] = m.snapshot().messages;
    expect(msg.role).toBe('assistant');
    expect(msg.blocks).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(msg.isStreaming).toBe(true);
    expect(m.snapshot().turn).toBe('streaming');
    expect(m.snapshot().lastSeq).toBe(2);
  });

  test('done finalizes streaming and records usage', () => {
    const m = new AgentChatModel();
    m.apply({ t: 'agent.delta', seq: 1, text: 'hi' });
    m.apply({
      t: 'agent.done',
      seq: 2,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    });
    const s = m.snapshot();
    expect(s.messages[0].isStreaming).toBe(false);
    expect(s.messages[0].usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
    expect(s.turn).toBe('idle');
  });

  test('error appends an error message', () => {
    const m = new AgentChatModel();
    m.apply({ t: 'agent.error', seq: 1, message: 'boom' });
    const s = m.snapshot();
    expect(s.messages.at(-1)).toMatchObject({ role: 'error' });
    expect(s.turn).toBe('idle');
  });

  test('ignores frames at or below lastSeq (replay dedupe)', () => {
    const m = new AgentChatModel();
    m.apply({ t: 'agent.delta', seq: 5, text: 'a' });
    m.apply({ t: 'agent.delta', seq: 5, text: 'DUP' });
    expect(m.snapshot().messages[0].blocks).toEqual([{ type: 'text', text: 'a' }]);
  });

  test('subscribe fires on apply', () => {
    const m = new AgentChatModel();
    let hits = 0;
    m.subscribe(() => {
      hits += 1;
    });
    m.apply({ t: 'agent.delta', seq: 1, text: 'x' });
    expect(hits).toBe(1);
  });
});

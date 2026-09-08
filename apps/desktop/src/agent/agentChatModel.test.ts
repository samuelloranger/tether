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

  test('tool then tool_result attaches result and diff for Edit', () => {
    const m = new AgentChatModel();
    m.apply({
      t: 'agent.tool',
      seq: 1,
      id: 't1',
      name: 'Edit',
      summary: 'edit foo',
      inputJson: JSON.stringify({ file_path: '/foo', old_string: 'a', new_string: 'b' }),
    });
    m.apply({ t: 'agent.tool_result', seq: 2, id: 't1', result: 'ok', isError: false });
    const msg = m.snapshot().messages.at(-1)!;
    const block = msg.blocks.find((b) => b.type === 'tool');
    expect(block).toBeTruthy();
    if (block?.type === 'tool') {
      expect(block.tool.result).toBe('ok');
      expect(block.tool.diff?.path).toBe('/foo');
    }
  });

  test('permission_req sets pendingApproval; resolve promotes backlog', () => {
    const m = new AgentChatModel();
    m.apply({
      t: 'agent.permission_req',
      seq: 1,
      id: 'p1',
      name: 'Bash',
      summary: 'rm -rf',
      inputJson: '{}',
    });
    m.apply({
      t: 'agent.permission_req',
      seq: 2,
      id: 'p2',
      name: 'Write',
      summary: 'x',
      inputJson: '{}',
    });
    expect(m.snapshot().pendingApproval?.id).toBe('p1');
    expect(m.resolvePermission(true)).toEqual({ id: 'p1' });
    expect(m.snapshot().pendingApproval?.id).toBe('p2');
    expect(m.resolvePermission(false)).toEqual({ id: 'p2' });
    expect(m.snapshot().pendingApproval).toBeNull();
  });

  test('draft and queue', () => {
    const m = new AgentChatModel();
    m.setDraft('hi');
    expect(m.snapshot().draft).toBe('hi');
    m.enqueue('one');
    m.enqueue('two');
    expect(m.snapshot().queued).toEqual(['one', 'two']);
    expect(m.dequeue()).toBe('one');
    expect(m.snapshot().queued).toEqual(['two']);
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

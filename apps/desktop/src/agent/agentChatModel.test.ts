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
      cost: 0.001,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const s = m.snapshot();
    expect(s.messages[0].isStreaming).toBe(false);
    expect(s.messages[0].usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
    expect(s.turn).toBe('idle');
  });

  test('sessionUsage accumulates across turns', () => {
    const m = new AgentChatModel();
    expect(m.snapshot().sessionUsage).toBeNull();
    m.apply({ t: 'agent.delta', seq: 1, text: 'a' });
    m.apply({
      t: 'agent.done',
      seq: 2,
      cost: 0.5,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    m.apply({ t: 'agent.delta', seq: 3, text: 'b' });
    m.apply({
      t: 'agent.done',
      seq: 4,
      cost: 0.25,
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    expect(m.snapshot().sessionUsage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      costUsd: 0.75,
    });
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
      name: 'Edit',
      input: { file_path: '/foo', old_string: 'a', new_string: 'b' },
    });
    m.apply({ t: 'agent.tool_result', seq: 2, text: 'ok', isError: false });
    const msg = m.snapshot().messages.at(-1)!;
    const block = msg.blocks.find((b) => b.type === 'tool');
    expect(block).toBeTruthy();
    if (block?.type === 'tool') {
      expect(block.tool.result).toBe('ok');
      expect(block.tool.summary).toBe('/foo');
      expect(block.tool.diff?.path).toBe('/foo');
    }
  });

  test('permission_req sets pendingApproval; resolve promotes backlog', () => {
    const m = new AgentChatModel();
    m.apply({
      t: 'agent.permission_req',
      reqId: 'p1',
      name: 'Bash',
      input: { command: 'rm -rf' },
    });
    m.apply({
      t: 'agent.permission_req',
      reqId: 'p2',
      name: 'Write',
      input: { file_path: 'x' },
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

  test('removeQueued cancels one queued prompt', () => {
    const m = new AgentChatModel();
    m.enqueue('one');
    m.enqueue('two');
    m.enqueue('three');
    m.removeQueued(1);
    expect(m.snapshot().queued).toEqual(['one', 'three']);
    m.removeQueued(9); // out of range is a no-op
    expect(m.snapshot().queued).toEqual(['one', 'three']);
  });

  test('retryLast drops trailing error and returns last prompt', () => {
    const m = new AgentChatModel();
    m.pushUserPrompt('do it');
    expect(m.snapshot().canRetry).toBe(false); // not idle
    m.apply({ t: 'agent.error', seq: 1, message: 'boom' });
    expect(m.snapshot().canRetry).toBe(true);
    expect(m.snapshot().messages.at(-1)?.role).toBe('error');
    expect(m.retryLast()).toBe('do it');
    expect(m.snapshot().messages.at(-1)?.role).toBe('user');
    expect(m.snapshot().turn).toBe('thinking');
    expect(m.snapshot().canRetry).toBe(false);
  });

  test('retryLast is null with no prior prompt', () => {
    const m = new AgentChatModel();
    expect(m.retryLast()).toBeNull();
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

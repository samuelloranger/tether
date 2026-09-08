import { expect, test } from 'bun:test';
import { isMessageStartEvent, mapClaudeLine } from './agentClaudeDriver';

test('init line yields no event', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc123' });
  expect(mapClaudeLine(line)).toBeNull();
});

test('text_delta stream_event yields a delta', () => {
  const line = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
  });
  expect(mapClaudeLine(line)).toEqual({ t: 'delta', text: 'hello' });
});

test('non-text stream_event yields no event', () => {
  const line = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } },
  });
  expect(mapClaudeLine(line)).toBeNull();
});

test('assistant message with single tool_use yields one tool event', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
  });
  expect(mapClaudeLine(line)).toEqual([{ t: 'tool', name: 'Bash', input: { command: 'ls' } }]);
});

test('assistant message skips text blocks', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'already streamed via deltas' }] },
  });
  expect(mapClaudeLine(line)).toBeNull();
});

test('assistant message with multiple tool_use blocks yields multiple tool events', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
      ],
    },
  });
  expect(mapClaudeLine(line)).toEqual([
    { t: 'tool', name: 'Bash', input: { command: 'ls' } },
    { t: 'tool', name: 'Read', input: { file_path: '/x' } },
  ]);
});

test('user message with string tool_result content', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'file1\nfile2', is_error: false }] },
  });
  expect(mapClaudeLine(line)).toEqual([{ t: 'tool_result', text: 'file1\nfile2', isError: false }]);
});

test('user message with array tool_result content joins text fields', () => {
  const line = JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          content: [
            { type: 'text', text: 'part1' },
            { type: 'text', text: 'part2' },
          ],
          is_error: true,
        },
      ],
    },
  });
  expect(mapClaudeLine(line)).toEqual([{ t: 'tool_result', text: 'part1\npart2', isError: true }]);
});

test('user message tool_result truncates to 4000 chars', () => {
  const long = 'x'.repeat(5000);
  const line = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: long, is_error: false }] },
  });
  const result = mapClaudeLine(line) as Array<{ text: string }>;
  expect(result[0].text.length).toBe(4000);
});

test('result line yields done with cost and usage', () => {
  const line = JSON.stringify({
    type: 'result',
    total_cost_usd: 0.0123,
    duration_ms: 4567,
    is_error: false,
    result: 'ok',
  });
  expect(mapClaudeLine(line)).toEqual({
    t: 'done',
    cost: 0.0123,
    usage: { duration_ms: 4567, is_error: false },
  });
});

test('result line without total_cost_usd defaults cost to 0', () => {
  const line = JSON.stringify({ type: 'result', duration_ms: 100, is_error: true });
  expect(mapClaudeLine(line)).toEqual({
    t: 'done',
    cost: 0,
    usage: { duration_ms: 100, is_error: true },
  });
});

test('malformed JSON line yields null', () => {
  expect(mapClaudeLine('{not valid json')).toBeNull();
});

test('empty line yields null', () => {
  expect(mapClaudeLine('')).toBeNull();
  expect(mapClaudeLine('   ')).toBeNull();
});

test('unknown top-level type yields null', () => {
  expect(mapClaudeLine(JSON.stringify({ type: 'something_else' }))).toBeNull();
});

test('isMessageStartEvent recognizes a stream_event message_start', () => {
  const line = JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } });
  expect(isMessageStartEvent(line)).toBe(true);
});

test('isMessageStartEvent is false for other stream_events', () => {
  const line = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
  });
  expect(isMessageStartEvent(line)).toBe(false);
});

test('isMessageStartEvent is false for non stream_event lines', () => {
  expect(isMessageStartEvent(JSON.stringify({ type: 'assistant', message: {} }))).toBe(false);
  expect(isMessageStartEvent('not json')).toBe(false);
});

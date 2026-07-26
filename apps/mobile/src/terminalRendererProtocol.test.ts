import { describe, expect, test } from 'bun:test';
import {
  OutputBatcher,
  parseRendererEvent,
  RendererQueue,
  type RendererCommand,
} from './terminalRendererProtocol';

describe('parseRendererEvent', () => {
  test('accepts known versioned events and rejects malformed data', () => {
    expect(parseRendererEvent('{"v":1,"type":"input","text":"ls\\r"}')).toEqual({
      v: 1,
      type: 'input',
      text: 'ls\r',
    });
    expect(parseRendererEvent('{"v":2,"type":"input","text":"x"}')).toBeNull();
    expect(parseRendererEvent('{"v":1,"type":"resize","cols":0,"rows":24}')).toBeNull();
    expect(parseRendererEvent('not json')).toBeNull();
  });
});

test('RendererQueue hydrates before writes and survives a remount', () => {
  const sent: RendererCommand[] = [];
  const queue = new RendererQueue((command) => sent.push(command));
  queue.write('before');
  queue.hydrate('state', 80, 24, { foreground: '#fff', background: '#000' });
  queue.ready();
  queue.write('after');
  expect(sent.map((command) => command.type)).toEqual(['hydrate', 'write', 'write']);
  queue.notReady();
  queue.write('remount');
  queue.ready();
  expect(sent.at(-1)).toEqual({ v: 1, type: 'write', data: 'remount' });
});

test('OutputBatcher joins active-session chunks into one delivery', () => {
  const scheduled: (() => void)[] = [];
  const writes: string[] = [];
  const batcher = new OutputBatcher(
    () => 'term-1',
    (chunk) => writes.push(chunk),
    (flush) => scheduled.push(flush),
  );
  batcher.push('term-1', 'a');
  batcher.push('term-2', 'ignored');
  batcher.push('term-1', 'b');
  expect(writes).toEqual([]);
  scheduled[0]();
  expect(writes).toEqual(['ab']);
});

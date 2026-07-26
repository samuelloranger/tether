import { describe, expect, test } from 'bun:test';
import {
  OutputBatcher,
  parseRendererEvent,
  RendererQueue,
  type RendererCommand,
} from './terminalRendererProtocol';
import { rendererLinksForRow } from './terminalRendererLinks';

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
  queue.hydrate(
    'state',
    80,
    24,
    { foreground: '#fff', background: '#000' },
    'Fira Code',
    13,
  );
  queue.ready();
  queue.write('after');
  expect(sent.map((command) => command.type)).toEqual(['hydrate', 'write', 'write']);
  expect(sent[0]).toEqual({
    v: 1,
    type: 'hydrate',
    data: 'state',
    cols: 80,
    rows: 24,
    theme: { foreground: '#fff', background: '#000' },
    fontFamily: 'Fira Code',
    fontSize: 13,
  });
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

test('renderer links preserve a wrapped target and convert columns to xterm coordinates', () => {
  const links = rendererLinksForRow(
    ['see https://example.com/long/', 'path and src/app.ts:12:3'],
    [true, false],
    1,
  );
  expect(links).toEqual([
    {
      range: { start: { x: 1, y: 2 }, end: { x: 4, y: 2 } },
      text: 'path',
      target: { kind: 'external', url: 'https://example.com/long/path' },
    },
    {
      range: { start: { x: 10, y: 2 }, end: { x: 24, y: 2 } },
      text: 'src/app.ts:12:3',
      target: { kind: 'file', path: 'src/app.ts', line: 12, column: 3 },
    },
  ]);
});

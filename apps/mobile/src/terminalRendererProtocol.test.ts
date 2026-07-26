import { describe, expect, test } from 'bun:test';
import type { Terminal } from '@xterm/xterm';
import {
  OutputBatcher,
  parseRendererEvent,
  RendererQueue,
  type RendererCommand,
} from './terminalRendererProtocol';
import { registerTetherLinks, rendererLinksForRow } from './terminalRendererLinks';

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

test('RendererQueue replaces React Native font keys at the native WebView boundary', () => {
  const sent: RendererCommand[] = [];
  const queue = new RendererQueue((command) => sent.push(command), { native: true });
  queue.hydrate(
    '',
    80,
    24,
    { foreground: '#fff', background: '#000' },
    'FiraCode_400Regular',
    13,
  );
  queue.ready();
  expect(sent[0]).toMatchObject({
    type: 'hydrate',
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
  });
});

test('RendererQueue drops writes belonging to a superseded hydration', () => {
  const sent: RendererCommand[] = [];
  const queue = new RendererQueue((command) => sent.push(command));
  const theme = { foreground: '#fff', background: '#000' };
  queue.hydrate('term-1', 80, 24, theme, 'monospace', 12);
  queue.write('stale');
  queue.hydrate('term-2', 100, 30, theme, 'monospace', 12);
  queue.write('fresh');
  queue.ready();
  expect(sent).toEqual([
    {
      v: 1,
      type: 'hydrate',
      data: 'term-2',
      cols: 100,
      rows: 30,
      theme,
      fontFamily: 'monospace',
      fontSize: 12,
    },
    { v: 1, type: 'write', data: 'fresh' },
  ]);
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

test('OutputBatcher cannot flush a new session from an old scheduled callback', () => {
  let activeId = 'term-1';
  const scheduled: (() => void)[] = [];
  const writes: string[] = [];
  const batcher = new OutputBatcher(
    () => activeId,
    (chunk) => writes.push(chunk),
    (flush) => scheduled.push(flush),
  );
  batcher.push('term-1', 'stale');
  batcher.clear();
  activeId = 'term-2';
  batcher.push('term-2', 'fresh');

  expect(scheduled).toHaveLength(2);
  scheduled[0]();
  expect(writes).toEqual([]);
  scheduled[1]();
  expect(writes).toEqual(['fresh']);
});

test('RendererQueue forwards scroll only after hydration', () => {
  const sent: RendererCommand[] = [];
  const queue = new RendererQueue((command) => sent.push(command));
  queue.scrollToLine(42);
  queue.hydrate('state', 80, 24, { foreground: '#fff', background: '#000' }, 'monospace', 12);
  queue.ready();
  queue.scrollToLine(42);
  queue.selectAll();
  expect(sent.slice(-2)).toEqual([
    { v: 1, type: 'scroll', line: 42 },
    { v: 1, type: 'selectAll' },
  ]);
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

test('OSC 8 links use the app link handler instead of WebView navigation', () => {
  const opened: unknown[] = [];
  const terminal = {
    options: {},
    registerLinkProvider: () => ({ dispose() {} }),
  } as unknown as Terminal;

  registerTetherLinks(terminal, (target) => opened.push(target));
  terminal.options.linkHandler?.activate(
    {} as MouseEvent,
    'https://example.com/from-osc-8',
    {} as never,
  );

  expect(opened).toEqual([
    { kind: 'external', url: 'https://example.com/from-osc-8' },
  ]);
});

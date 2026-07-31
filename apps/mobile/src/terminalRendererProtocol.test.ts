import { describe, expect, test } from 'bun:test';
import type { Terminal } from '@xterm/xterm';
import { registerTetherLinks, rendererLinksForRow } from './terminalRendererLinks';
import {
  OutputBatcher,
  parseRendererEvent,
  type RendererCommand,
  RendererQueue,
  RendererRpc,
} from './terminalRendererProtocol';

describe('parseRendererEvent', () => {
  test('accepts known versioned events and rejects malformed data', () => {
    expect(parseRendererEvent('{"v":1,"type":"input","text":"ls\\r"}')).toEqual({
      v: 1,
      type: 'input',
      text: 'ls\r',
    });
    expect(parseRendererEvent('{"v":1,"type":"pong"}')).toEqual({ v: 1, type: 'pong' });
    expect(parseRendererEvent('{"v":2,"type":"input","text":"x"}')).toBeNull();
    expect(parseRendererEvent('{"v":1,"type":"resize","cols":0,"rows":24}')).toBeNull();
    expect(parseRendererEvent('not json')).toBeNull();
  });

  test('accepts control and rpc response events', () => {
    expect(parseRendererEvent('{"v":1,"type":"title","title":"vim"}')).toEqual({
      v: 1,
      type: 'title',
      title: 'vim',
    });
    expect(parseRendererEvent('{"v":1,"type":"bell"}')).toEqual({ v: 1, type: 'bell' });
    expect(
      parseRendererEvent(
        '{"v":1,"type":"modes","applicationCursor":true,"bracketedPaste":false,"mouseMode":"normal","mouseSgr":true,"cursorStyle":"bar","cursorVisible":true}',
      ),
    ).toMatchObject({ type: 'modes', applicationCursor: true, mouseMode: 'normal' });
    expect(parseRendererEvent('{"v":1,"type":"serialized","requestId":"1","data":"abc"}')).toEqual({
      v: 1,
      type: 'serialized',
      requestId: '1',
      data: 'abc',
      promptLines: [],
    });
    expect(
      parseRendererEvent(
        '{"v":1,"type":"serialized","requestId":"1","data":"abc","promptLines":[2]}',
      ),
    ).toEqual({
      v: 1,
      type: 'serialized',
      requestId: '1',
      data: 'abc',
      promptLines: [2],
    });
    expect(parseRendererEvent('{"v":1,"type":"hydrated"}')).toEqual({ v: 1, type: 'hydrated' });
    expect(parseRendererEvent('{"v":1,"type":"modes","applicationCursor":true}')).toBeNull();
  });
});

test('RendererRpc settles serialize requests', async () => {
  const sent: RendererCommand[] = [];
  const rpc = new RendererRpc((command) => sent.push(command), 1000);
  const pending = rpc.requestSerialize();
  expect(sent).toEqual([{ v: 1, type: 'serialize', requestId: '1' }]);
  rpc.settle('1', { data: 'STATE', promptLines: [3] });
  await expect(pending).resolves.toEqual({ data: 'STATE', promptLines: [3] });
});
test('RendererQueue hydrates before writes and survives a remount', () => {
  const sent: RendererCommand[] = [];
  const queue = new RendererQueue((command) => sent.push(command));
  queue.write('before');
  queue.hydrate('state', 80, 24, { foreground: '#fff', background: '#000' }, 'Fira Code', 13);
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
    fontFamily: '"Fira Code", ui-monospace, "SFMono-Regular", Menlo, monospace',
    fontSize: 13,
    promptLines: [],
  });
  queue.notReady();
  queue.write('remount');
  queue.ready();
  expect(sent.at(-1)).toEqual({ v: 1, type: 'write', data: 'remount' });
});

test('RendererQueue recovery replaces stale state before queued live writes', () => {
  const sent: RendererCommand[] = [];
  const queue = new RendererQueue((command) => sent.push(command));
  const hydrate = (data: string) =>
    queue.hydrate(data, 80, 24, { foreground: '#fff', background: '#000' }, 'monospace', 12);

  hydrate('old state');
  queue.ready();
  queue.write('already rendered');
  queue.recover(() => hydrate('fresh state'));
  queue.write('during recovery');
  queue.ready();

  expect(sent.slice(-2)).toEqual([
    expect.objectContaining({ type: 'hydrate', data: 'fresh state' }),
    { v: 1, type: 'write', data: 'during recovery' },
  ]);
});

// The page embeds the same TTFs the app bundles, so the RN family name is used
// as-is and the system stack is only a fallback for the frames before the
// data-URI font decodes. It used to be replaced outright, which is why the font
// picker had no effect on mobile.
test('RendererQueue keeps the chosen font and appends a system fallback', () => {
  const sent: RendererCommand[] = [];
  const queue = new RendererQueue((command) => sent.push(command));
  queue.hydrate('', 80, 24, { foreground: '#fff', background: '#000' }, 'FiraCode_400Regular', 13);
  queue.ready();
  expect(sent[0]).toMatchObject({
    type: 'hydrate',
    fontFamily: '"FiraCode_400Regular", ui-monospace, "SFMono-Regular", Menlo, monospace',
  });
});

test('RendererQueue drops writes belonging to a superseded hydration', () => {
  const sent: RendererCommand[] = [];
  const queue = new RendererQueue((command) => sent.push(command));
  const theme = { foreground: '#fff', background: '#000' };
  const font = '"monospace", ui-monospace, "SFMono-Regular", Menlo, monospace';
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
      fontFamily: font,
      fontSize: 12,
      promptLines: [],
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

test('RendererQueue forwards blur only after hydration', () => {
  const sent: RendererCommand[] = [];
  const queue = new RendererQueue((command) => sent.push(command));
  queue.blur();
  queue.hydrate('state', 80, 24, { foreground: '#fff', background: '#000' }, 'monospace', 12);
  queue.ready();
  queue.blur();
  expect(sent.at(-1)).toEqual({ v: 1, type: 'blur' });
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

  expect(opened).toEqual([{ kind: 'external', url: 'https://example.com/from-osc-8' }]);
});

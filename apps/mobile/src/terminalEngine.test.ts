import { expect, test } from 'bun:test';
import './xtermPolyfill';
import { Terminal } from '@xterm/headless';

// xterm buffers writes and flushes on a later tick; await the write callback.
function flush(t: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => t.write(data, resolve));
}

test('xterm headless imports and writes under the shim', async () => {
  const t = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  expect(t.cols).toBe(20);
  await flush(t, 'hi');
  expect(t.buffer.active.getLine(0)?.translateToString(true)).toContain('hi');
});

import type { TerminalViewHandle } from './TerminalView.types';
import type { RendererQueue, RendererRpc } from './terminalRendererProtocol';

export function createTerminalHandle(
  queue: RendererQueue,
  rpc: RendererRpc,
  hydrateWait: { current: (() => void) | null },
  retry: () => void,
): TerminalViewHandle {
  return {
    hydrate: (...args) =>
      new Promise<void>((resolve) => {
        hydrateWait.current = resolve;
        queue.hydrate(...args);
      }),
    write: (data) => queue.write(data),
    resize: (cols, rows) => queue.resize(cols, rows),
    scrollToLine: (line) => queue.scrollToLine(line),
    selectAll: () => queue.selectAll(),
    focus: () => queue.focus(),
    blur: () => queue.blur(),
    retry,
    serialize: () => rpc.requestSerialize(),
    snapshotText: () => rpc.requestSnapshotText(),
    jumpPrompt: (dir) => queue.jumpPrompt(dir),
  };
}

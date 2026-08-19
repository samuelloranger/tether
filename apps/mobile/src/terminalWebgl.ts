import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

// The WebGL renderer is optional: construction throws on machines without a
// usable context, and the context can be lost at runtime. Both paths fall back
// to the DOM renderer and report it. Kept in its own module so the addon can be
// mocked without dragging xterm's DOM-bound entry points into a test.
export type WebglFallback = { current: { onFallback: (reason: string) => void } };

export function attachWebgl(
  terminal: Pick<Terminal, 'loadAddon' | 'refresh' | 'rows'>,
  callbacks: WebglFallback,
): { dispose: () => void } {
  let webgl: WebglAddon | null = null;
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      // Null it out so the caller's unmount cleanup does not dispose it twice.
      webgl?.dispose();
      webgl = null;
      // Read .current at event time: the callbacks object is swapped on every
      // render, so capturing it at mount pins a stale onFallback.
      callbacks.current.onFallback('webgl-context-lost');
      terminal.refresh(0, terminal.rows - 1);
    });
    terminal.loadAddon(webgl);
  } catch (error) {
    webgl = null;
    callbacks.current.onFallback(String(error));
  }
  return { dispose: () => webgl?.dispose() };
}

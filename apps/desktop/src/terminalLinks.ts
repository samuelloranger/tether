import { openUrl } from '@tauri-apps/plugin-opener';
import type { IDisposable, ILink, Terminal } from '@xterm/xterm';
import { coreDetectLinks, type DetectedLinkSpan } from './coreApi';

/** Desktop requires Ctrl/Cmd+click so a drag-select isn't hijacked. */
export function shouldActivateLink(
  event: { ctrlKey?: boolean; metaKey?: boolean } | undefined,
  requireModifierClick: boolean,
): boolean {
  if (!requireModifierClick) return true;
  return !!(event?.ctrlKey || event?.metaKey);
}

export async function activateLinkTarget(target: DetectedLinkSpan['target']): Promise<void> {
  if (target.kind === 'external') {
    await openUrl(target.url);
    return;
  }
  // Sprint D owns the file viewer. A path match is a no-op until then.
}

export function rendererLinksForRow(
  texts: string[],
  spans: DetectedLinkSpan[][] | undefined,
  rowIndex: number,
): Array<{ range: ILink['range']; text: string; target: DetectedLinkSpan['target'] }> {
  const text = texts[rowIndex];
  const row = spans?.[rowIndex];
  if (text === undefined || !row) return [];
  return row.map((span) => ({
    range: {
      start: { x: span.start + 1, y: rowIndex + 1 },
      end: { x: span.end, y: rowIndex + 1 },
    },
    text: text.slice(span.start, span.end),
    target: span.target,
  }));
}

export function registerTetherLinks(
  terminal: Terminal,
  opts?: { requireModifierClick?: boolean },
): IDisposable {
  const requireModifierClick = opts?.requireModifierClick ?? true;
  let cache: DetectedLinkSpan[][] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const snapshot = () => {
    const buffer = terminal.buffer.active;
    const texts: string[] = new Array(buffer.length);
    const wrapped: boolean[] = new Array(buffer.length);
    for (let y = 0; y < buffer.length; y++) {
      texts[y] = buffer.getLine(y)?.translateToString(false) ?? '';
      wrapped[y] = buffer.getLine(y + 1)?.isWrapped ?? false;
    }
    return { texts, wrapped };
  };

  const refresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const { texts, wrapped } = snapshot();
      void coreDetectLinks(texts, wrapped)
        .then((spans) => {
          cache = spans;
        })
        .catch(() => {});
    }, 40);
  };

  const disposable = terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const { texts } = snapshot();
      const links: ILink[] = rendererLinksForRow(texts, cache, bufferLineNumber - 1).map(
        (link) => ({
          range: link.range,
          text: link.text,
          activate: (event) => {
            if (!shouldActivateLink(event, requireModifierClick)) return;
            void activateLinkTarget(link.target);
          },
        }),
      );
      callback(links.length ? links : undefined);
    },
  });

  const onWrite = terminal.onWriteParsed(() => refresh());
  refresh();

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      onWrite.dispose();
      disposable.dispose();
    },
  };
}

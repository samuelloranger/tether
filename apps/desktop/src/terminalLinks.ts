import type { IDisposable, ILink, Terminal } from '@xterm/xterm';
import { coreDetectLinks, coreOpenExternal, type DetectedLinkSpan } from './coreApi';
import { requestFileOpen } from './fileOpenBus';

/** When true, Ctrl/Cmd+click is required so a drag-select isn't hijacked. */
export function shouldActivateLink(
  event: { ctrlKey?: boolean; metaKey?: boolean } | undefined,
  requireModifierClick: boolean,
): boolean {
  if (!requireModifierClick) return true;
  return !!(event?.ctrlKey || event?.metaKey);
}

export async function activateLinkTarget(target: DetectedLinkSpan['target']): Promise<void> {
  if (target.kind === 'external') {
    await coreOpenExternal(target.url);
    return;
  }
  requestFileOpen(target.path, target.line ?? undefined, target.column ?? undefined);
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
  // Plain click opens — same as iOS tap. Drag-select still works because xterm
  // only fires link activate on click, not on drag.
  const requireModifierClick = opts?.requireModifierClick ?? false;

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

  const disposable = terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const { texts, wrapped } = snapshot();
      // Resolve spans for this call — a debounced side cache left clicks racing
      // the detector with an empty map, so the underline never appeared and
      // activate never ran.
      void coreDetectLinks(texts, wrapped)
        .then((spans) => {
          const links: ILink[] = rendererLinksForRow(texts, spans, bufferLineNumber - 1).map(
            (link) => ({
              range: link.range,
              text: link.text,
              activate: (event) => {
                if (!shouldActivateLink(event, requireModifierClick)) return;
                void activateLinkTarget(link.target).catch(() => {});
              },
            }),
          );
          callback(links.length ? links : undefined);
        })
        .catch(() => {
          callback(undefined);
        });
    },
  });

  return {
    dispose() {
      disposable.dispose();
    },
  };
}

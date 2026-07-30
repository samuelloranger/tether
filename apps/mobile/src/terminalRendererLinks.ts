import type { IBufferRange, IDisposable, ILink, Terminal } from '@xterm/xterm';
import { computeLinkSpans, type LinkTarget } from './links';

export interface RendererLink {
  range: IBufferRange;
  text: string;
  target: LinkTarget;
}

export function rendererLinksForRow(
  texts: string[],
  wrapped: boolean[],
  rowIndex: number,
): RendererLink[] {
  const text = texts[rowIndex];
  if (text === undefined) return [];
  return computeLinkSpans(texts, wrapped)[rowIndex].map((span) => ({
    range: {
      start: { x: span.start + 1, y: rowIndex + 1 },
      end: { x: span.end, y: rowIndex + 1 },
    },
    text: text.slice(span.start, span.end),
    target: span.target,
  }));
}

/** Mobile tap opens. Desktop requires Ctrl/Cmd+click so selection isn't hijacked. */
export function shouldActivateLink(
  event: { ctrlKey?: boolean; metaKey?: boolean } | undefined,
  requireModifierClick: boolean,
): boolean {
  if (!requireModifierClick) return true;
  return !!(event?.ctrlKey || event?.metaKey);
}

export function registerTetherLinks(
  terminal: Terminal,
  activate: (target: LinkTarget) => void,
  opts?: { requireModifierClick?: boolean },
): IDisposable {
  const requireModifierClick = opts?.requireModifierClick ?? false;
  terminal.options.linkHandler = {
    activate: (event, url) => {
      if (!shouldActivateLink(event, requireModifierClick)) return;
      activate({ kind: 'external', url });
    },
  };
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active;
      const texts: string[] = new Array(buffer.length);
      const wrapped: boolean[] = new Array(buffer.length);
      for (let y = 0; y < buffer.length; y++) {
        texts[y] = buffer.getLine(y)?.translateToString(false) ?? '';
        wrapped[y] = buffer.getLine(y + 1)?.isWrapped ?? false;
      }
      const links: ILink[] = rendererLinksForRow(texts, wrapped, bufferLineNumber - 1).map(
        (link) => ({
          range: link.range,
          text: link.text,
          activate: (event) => {
            if (!shouldActivateLink(event, requireModifierClick)) return;
            activate(link.target);
          },
        }),
      );
      callback(links.length ? links : undefined);
    },
  });
}

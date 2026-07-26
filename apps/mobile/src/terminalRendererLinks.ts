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

export function registerTetherLinks(
  terminal: Terminal,
  activate: (target: LinkTarget) => void,
): IDisposable {
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
          activate: () => activate(link.target),
        }),
      );
      callback(links.length ? links : undefined);
    },
  });
}

import type { RefObject } from 'react';
import type { LinkTarget } from './links';
import type { RendererTheme } from './terminalRendererProtocol';

export interface TerminalViewHandle {
  hydrate(
    data: string,
    cols: number,
    rows: number,
    theme: RendererTheme,
    fontFamily: string,
    fontSize: number,
  ): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  focus(): void;
}

export interface TerminalViewProps {
  ref?: RefObject<TerminalViewHandle | null>;
  onInput(text: string): void;
  onResize(cols: number, rows: number): void;
  onOpenLink(target: LinkTarget): void;
  onFallback(reason: string): void;
}

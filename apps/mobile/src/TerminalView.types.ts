import type { RefObject } from 'react';
import type { LinkTarget } from './links';
import type { RendererStatus } from './rendererLifecycle';
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
  scrollToLine(line: number): void;
  selectAll(): void;
  focus(): void;
  blur(): void;
  /** Manual recovery from the stalled UI: throw the page away and start over. */
  retry(): void;
}

export interface TerminalViewProps {
  ref?: RefObject<TerminalViewHandle | null>;
  onInput(text: string): void;
  onResize(cols: number, rows: number): void;
  onOpenLink(target: LinkTarget): void;
  onSelection?(text: string): void;
  /** Desktop: Ctrl/Cmd+V / Shift+Insert from the xterm key handler. */
  onPaste?(): void | Promise<void>;
  /** Desktop: Ctrl/Cmd+T. */
  onNewTerminal?(): void;
  /** Desktop: Ctrl/Cmd+= or Ctrl/Cmd+-. */
  onFontZoom?(delta: number): void;
  onFallback(reason: string): void;
  onRecover(): void;
  /** Renderer readiness, so a dead page can be shown instead of a blank one. */
  onStatus?(status: RendererStatus): void;
}

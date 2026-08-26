import type { Terminal } from '@xterm/xterm';
import { coreMouseCell, coreMouseEncode } from './coreApi';

export type MouseModeName = 'off' | 'x10' | 'normal' | 'button' | 'any';

export function mouseModeFromXterm(mode: string | undefined): MouseModeName {
  switch (mode) {
    case 'x10':
      return 'x10';
    case 'vt200':
      return 'normal';
    case 'drag':
      return 'button';
    case 'any':
      return 'any';
    default:
      return 'off';
  }
}

function modsFromEvent(event: MouseEvent): number {
  return (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0);
}

function screenRect(term: Terminal): DOMRect | null {
  const el = term.element?.querySelector('.xterm-screen') ?? term.element;
  return el?.getBoundingClientRect() ?? null;
}

async function reportMouse(
  term: Terminal,
  opts: {
    send: (bytes: string) => void;
    isInteractive: () => boolean;
    mouseSgr: () => boolean;
  },
  kind: string,
  event: MouseEvent,
  btn: number,
  mode: MouseModeName,
): Promise<void> {
  if (!opts.isInteractive() || mode === 'off') return;
  const rect = screenRect(term);
  if (!rect || rect.width === 0 || rect.height === 0) return;
  const cell = await coreMouseCell({
    x: event.clientX,
    y: event.clientY,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    cols: term.cols,
    rows: term.rows,
  });
  const seqs = await coreMouseEncode({
    kind,
    col: cell.col,
    row: cell.row,
    mode,
    sgr: opts.mouseSgr(),
    btn,
    mods: modsFromEvent(event),
  });
  for (const seq of seqs) opts.send(seq);
}

export function attachTerminalMouse(
  term: Terminal,
  opts: {
    send: (bytes: string) => void;
    isInteractive: () => boolean;
    mouseSgr: () => boolean;
  },
): () => void {
  const element = term.element;
  if (!element) return () => {};

  let buttons = 0;
  let raf = 0;
  let pending: MouseEvent | null = null;
  const mode = () => mouseModeFromXterm(term.modes.mouseTrackingMode);

  const onDown = (event: MouseEvent) => {
    if (mode() === 'off') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    buttons = event.buttons;
    void reportMouse(term, opts, 'press', event, event.button, mode());
  };

  const onMove = (event: MouseEvent) => {
    if (mode() === 'off') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pending = event;
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next = pending;
        pending = null;
        if (!next) return;
        const current = mode();
        if (current === 'button' && buttons === 0) return;
        if (current !== 'button' && current !== 'any') return;
        void reportMouse(term, opts, 'motion', next, 0, current);
      });
    }
  };

  const onUp = (event: MouseEvent) => {
    if (mode() === 'off') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    buttons = event.buttons;
    void reportMouse(term, opts, 'release', event, event.button, mode());
  };

  const onWheel = (event: WheelEvent) => {
    if (mode() === 'off') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void reportMouse(term, opts, 'wheel', event, event.deltaY < 0 ? 64 : 65, mode());
  };

  const capture = true;
  element.addEventListener('mousedown', onDown, capture);
  window.addEventListener('mousemove', onMove, capture);
  window.addEventListener('mouseup', onUp, capture);
  element.addEventListener('wheel', onWheel, { capture, passive: false });

  return () => {
    if (raf) cancelAnimationFrame(raf);
    element.removeEventListener('mousedown', onDown, capture);
    window.removeEventListener('mousemove', onMove, capture);
    window.removeEventListener('mouseup', onUp, capture);
    element.removeEventListener('wheel', onWheel, capture);
  };
}

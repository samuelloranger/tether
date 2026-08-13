import { SerializeAddon } from '@xterm/addon-serialize';
import type { IMarker, Terminal } from '@xterm/xterm';
import {
  type ControlHost,
  type CursorStyle,
  registerTerminalControls,
  type TerminalControls,
} from './terminalControls';
import type { MouseMode, PageControlEvent } from './tether/pageControlState';

export type PageHostEmit =
  | PageControlEvent
  | { type: 'reply'; data: string }
  | { type: 'clipboardWrite'; text: string }
  | { type: 'serialized'; requestId: string; data: string; promptLines: number[] }
  | { type: 'snapshotText'; requestId: string; text: string }
  | { type: 'hydrated' };

function mouseModeOf(mode: string): MouseMode {
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

export function bufferPlainText(terminal: Terminal): string {
  const buf = terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines.join('\n').replace(/\n+$/, '');
}

type PageBindCtx = {
  terminal: Terminal;
  emit: (event: PageHostEmit) => void;
  serializeAddon: SerializeAddon;
  promptMarkers: IMarker[];
  controls: TerminalControls | null;
  modes: { mouseSgr: boolean; cursorStyle: CursorStyle; cursorVisible: boolean };
};

function prunePromptMarkers(markers: IMarker[]): void {
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i].isDisposed || markers[i].line < 0) markers.splice(i, 1);
  }
}

function jumpPrompt(ctx: PageBindCtx, dir: 1 | -1): void {
  prunePromptMarkers(ctx.promptMarkers);
  const lines = ctx.promptMarkers.map((m) => m.line).sort((a, b) => a - b);
  if (!lines.length) return;
  const viewport = ctx.terminal.buffer.active.viewportY;
  if (dir < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] < viewport) {
        ctx.terminal.scrollToLine(lines[i]);
        return;
      }
    }
    ctx.terminal.scrollToLine(lines[0]);
    return;
  }
  for (const line of lines) {
    if (line > viewport) {
      ctx.terminal.scrollToLine(line);
      return;
    }
  }
  ctx.terminal.scrollToLine(lines[lines.length - 1]);
}

function handlePageRpc(
  ctx: PageBindCtx,
  command: { type: string; requestId?: string; dir?: 1 | -1 },
): boolean {
  if (command.type === 'serialize' && typeof command.requestId === 'string') {
    prunePromptMarkers(ctx.promptMarkers);
    ctx.emit({
      type: 'serialized',
      requestId: command.requestId,
      data: ctx.serializeAddon.serialize(),
      promptLines: ctx.promptMarkers.map((m) => m.line).filter((line) => line >= 0),
    });
    return true;
  }
  if (command.type === 'snapshotText' && typeof command.requestId === 'string') {
    ctx.emit({
      type: 'snapshotText',
      requestId: command.requestId,
      text: bufferPlainText(ctx.terminal),
    });
    return true;
  }
  if (command.type === 'jumpPrompt' && (command.dir === 1 || command.dir === -1)) {
    jumpPrompt(ctx, command.dir);
    return true;
  }
  return false;
}

function restorePromptLines(ctx: PageBindCtx, lines: number[]): void {
  for (const marker of ctx.promptMarkers) {
    try {
      marker.dispose();
    } catch {
      // already disposed
    }
  }
  ctx.promptMarkers.length = 0;
  const buf = ctx.terminal.buffer.active;
  const origin = buf.baseY + buf.cursorY;
  for (const line of lines) {
    if (!Number.isInteger(line) || line < 0) continue;
    const marker = ctx.terminal.registerMarker(line - origin);
    if (marker) ctx.promptMarkers.push(marker);
  }
}

function resetPrompts(ctx: PageBindCtx): void {
  for (const marker of ctx.promptMarkers) {
    try {
      marker.dispose();
    } catch {
      // already disposed
    }
  }
  ctx.promptMarkers.length = 0;
  ctx.modes.mouseSgr = false;
  ctx.modes.cursorStyle = 'block';
  ctx.modes.cursorVisible = true;
  ctx.controls?.reset();
}

function attachPageControls(
  ctx: PageBindCtx,
  emitModes: () => void,
  colors: { foreground: string; background: string },
): TerminalControls {
  return registerTerminalControls(
    ctx.terminal as unknown as ControlHost,
    {
      title: (title) => ctx.emit({ type: 'title', title }),
      bell: () => ctx.emit({ type: 'bell' }),
      cwd: (path) => ctx.emit({ type: 'cwd', path }),
      notify: (title, body) => ctx.emit({ type: 'notify', title, body }),
      cursorStyle: (style) => {
        ctx.modes.cursorStyle = style;
        emitModes();
      },
      mouseSgr: (enabled) => {
        ctx.modes.mouseSgr = enabled;
        emitModes();
      },
      cursorVisible: (visible) => {
        ctx.modes.cursorVisible = visible;
        emitModes();
      },
      reply: (data) => ctx.emit({ type: 'reply', data }),
      clipboardWrite: (text) => ctx.emit({ type: 'clipboardWrite', text }),
    },
    colors,
  );
}

/** Attach control reporting, serialize/snapshot/jump, and mode sync to a live xterm page. */
export function bindPageTerminal(
  terminal: Terminal,
  emit: (event: PageHostEmit) => void,
  colors: { foreground: string; background: string },
): {
  handleRpc: (command: { type: string; requestId?: string; dir?: 1 | -1 }) => boolean;
  afterWrite: () => void;
  resetPrompts: () => void;
  restorePromptLines: (lines: number[]) => void;
  dispose: () => void;
} {
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  const ctx: PageBindCtx = {
    terminal,
    emit,
    serializeAddon,
    promptMarkers: [],
    controls: null,
    modes: { mouseSgr: false, cursorStyle: 'block', cursorVisible: true },
  };

  const emitModes = () => {
    const m = terminal.modes;
    emit({
      type: 'modes',
      applicationCursor: m.applicationCursorKeysMode,
      bracketedPaste: m.bracketedPasteMode,
      mouseMode: mouseModeOf(m.mouseTrackingMode),
      mouseSgr: ctx.modes.mouseSgr,
      cursorStyle: ctx.modes.cursorStyle,
      cursorVisible: ctx.modes.cursorVisible,
    });
  };

  ctx.controls = attachPageControls(ctx, emitModes, colors);

  terminal.parser.registerOscHandler(133, (data) => {
    if (data.startsWith('A')) {
      const marker = terminal.registerMarker(0);
      if (marker) ctx.promptMarkers.push(marker);
      emit({ type: 'promptReturn' });
    }
    return false;
  });

  return {
    handleRpc: (command) => handlePageRpc(ctx, command),
    afterWrite: emitModes,
    resetPrompts: () => resetPrompts(ctx),
    restorePromptLines: (lines) => restorePromptLines(ctx, lines),
    dispose: () => {
      resetPrompts(ctx);
      serializeAddon.dispose();
    },
  };
}

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
  | { type: 'serialized'; requestId: string; data: string }
  | { type: 'snapshotText'; requestId: string; text: string };

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

/** Attach control reporting, serialize/snapshot/jump, and mode sync to a live xterm page. */
export function bindPageTerminal(
  terminal: Terminal,
  emit: (event: PageHostEmit) => void,
  colors: { foreground: string; background: string },
): {
  handleRpc: (command: { type: string; requestId?: string; dir?: 1 | -1 }) => boolean;
  afterWrite: () => void;
  resetPrompts: () => void;
  dispose: () => void;
} {
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);

  let mouseSgr = false;
  let cursorStyle: CursorStyle = 'block';
  let cursorVisible = true;
  const promptMarkers: IMarker[] = [];
  let controls: TerminalControls | null = null;

  const emitModes = () => {
    const m = terminal.modes;
    emit({
      type: 'modes',
      applicationCursor: m.applicationCursorKeysMode,
      bracketedPaste: m.bracketedPasteMode,
      mouseMode: mouseModeOf(m.mouseTrackingMode),
      mouseSgr,
      cursorStyle,
      cursorVisible,
    });
  };

  controls = registerTerminalControls(
    terminal as unknown as ControlHost,
    {
      title: (title) => emit({ type: 'title', title }),
      bell: () => emit({ type: 'bell' }),
      cwd: (path) => emit({ type: 'cwd', path }),
      notify: (title, body) => emit({ type: 'notify', title, body }),
      cursorStyle: (style) => {
        cursorStyle = style;
        emitModes();
      },
      mouseSgr: (enabled) => {
        mouseSgr = enabled;
        emitModes();
      },
      cursorVisible: (visible) => {
        cursorVisible = visible;
        emitModes();
      },
      reply: (data) => emit({ type: 'reply', data }),
      clipboardWrite: (text) => emit({ type: 'clipboardWrite', text }),
    },
    colors,
  );

  terminal.parser.registerOscHandler(133, (data) => {
    if (data.startsWith('A')) {
      const marker = terminal.registerMarker(0);
      if (marker) promptMarkers.push(marker);
      emit({ type: 'promptReturn' });
    }
    return false;
  });

  const pruneMarkers = () => {
    for (let i = promptMarkers.length - 1; i >= 0; i--) {
      if (promptMarkers[i].isDisposed || promptMarkers[i].line < 0) promptMarkers.splice(i, 1);
    }
  };

  const jumpPrompt = (dir: 1 | -1) => {
    pruneMarkers();
    const lines = promptMarkers.map((m) => m.line).sort((a, b) => a - b);
    if (!lines.length) return;
    const viewport = terminal.buffer.active.viewportY;
    if (dir < 0) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i] < viewport) {
          terminal.scrollToLine(lines[i]);
          return;
        }
      }
      terminal.scrollToLine(lines[0]);
      return;
    }
    for (const line of lines) {
      if (line > viewport) {
        terminal.scrollToLine(line);
        return;
      }
    }
    terminal.scrollToLine(lines[lines.length - 1]);
  };

  const handleRpc = (command: { type: string; requestId?: string; dir?: 1 | -1 }): boolean => {
    if (command.type === 'serialize' && typeof command.requestId === 'string') {
      emit({ type: 'serialized', requestId: command.requestId, data: serializeAddon.serialize() });
      return true;
    }
    if (command.type === 'snapshotText' && typeof command.requestId === 'string') {
      emit({
        type: 'snapshotText',
        requestId: command.requestId,
        text: bufferPlainText(terminal),
      });
      return true;
    }
    if (command.type === 'jumpPrompt' && (command.dir === 1 || command.dir === -1)) {
      jumpPrompt(command.dir);
      return true;
    }
    return false;
  };

  const resetPrompts = () => {
    for (const marker of promptMarkers) {
      try {
        marker.dispose();
      } catch {
        // already disposed
      }
    }
    promptMarkers.length = 0;
    mouseSgr = false;
    cursorStyle = 'block';
    cursorVisible = true;
    controls?.reset();
  };

  return {
    handleRpc,
    afterWrite: emitModes,
    resetPrompts,
    dispose: () => {
      resetPrompts();
      serializeAddon.dispose();
    },
  };
}

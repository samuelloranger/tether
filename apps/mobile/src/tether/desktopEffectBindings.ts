import type { MutableRefObject } from 'react';
import type { TextInput } from 'react-native';
import { writeClipboard } from '../clipboard';
import { shouldForwardToTerminal, terminalAcceptsNavKeys } from '../desktopFocusGuard';
import {
  COPY,
  FONT_LARGER,
  FONT_SMALLER,
  isTerminalNavKey,
  keyNeedsFallback,
  keyToBytes,
  NEW_TERMINAL,
  PASTE,
  resolveKeyboardKey,
  SELECT_ALL,
} from '../desktopKeys';
import { isDesktop, isMacDesktop } from '../platform';
import type { Presentation } from '../presentations';
import type { SessionEntry } from '../sessionCache';

export type DesktopEffectOptions = {
  isConfiguring: boolean;
  presentations: Presentation[];
  activePresentationId: string | null;
  fileViewOpen: boolean;
  diffOpen: boolean;
  getSessionEntry: (id: string) => SessionEntry | undefined;
  getActiveSessionId: () => string;
  getTerminalSelection: () => string;
  inputRef: MutableRefObject<TextInput | null>;
  sendKey: (bytes: string) => void;
  sendPaste: (text: string) => void;
  handlePaste: () => Promise<void>;
  selectAllTerminal: () => void;
  newTerminal: () => void;
  changeFontSize: (delta: number) => void;
  setContextMenu: (position: { x: number; y: number }) => void;
  setWindowFocused: (focused: boolean) => void;
  isWindowFocused: () => boolean;
  refreshSocketActivity: () => void;
  activePromptReturnCount: number;
};

type KeyActions = Pick<
  DesktopEffectOptions,
  | 'getTerminalSelection'
  | 'handlePaste'
  | 'selectAllTerminal'
  | 'newTerminal'
  | 'changeFontSize'
  | 'sendKey'
>;

function applyDesktopKeyCommand(bytes: string, actions: KeyActions): boolean {
  if (bytes === COPY) {
    const text = actions.getTerminalSelection();
    if (text) void writeClipboard(text);
    return true;
  }
  if (bytes === PASTE) {
    void actions.handlePaste();
    return true;
  }
  if (bytes === SELECT_ALL) {
    actions.selectAllTerminal();
    return true;
  }
  if (bytes === NEW_TERMINAL) {
    actions.newTerminal();
    return true;
  }
  if (bytes === FONT_LARGER) {
    actions.changeFontSize(1);
    return true;
  }
  if (bytes === FONT_SMALLER) {
    actions.changeFontSize(-1);
    return true;
  }
  return false;
}

function previewBlocksKeys(
  isConfiguring: boolean,
  presentations: Presentation[],
  activePresentationId: string | null,
): boolean {
  return (
    !isDesktop ||
    isConfiguring ||
    presentations.some((preview) => preview.id === activePresentationId)
  );
}

function focusHelpers(fileViewOpen: boolean, diffOpen: boolean) {
  const activeEl = () =>
    document.activeElement as
      | (HTMLElement & { isContentEditable?: boolean; classList?: DOMTokenList })
      | null;
  const terminalVisible = () => !fileViewOpen && !diffOpen;
  const focused = () =>
    shouldForwardToTerminal(
      activeEl(),
      document.activeElement === document.body,
      terminalVisible(),
    );
  const navFocused = () => {
    const el = activeEl();
    return terminalAcceptsNavKeys(
      el,
      document.activeElement === document.body,
      terminalVisible(),
      !!el?.classList?.contains('xterm-helper-textarea'),
    );
  };
  return { focused, navFocused };
}

export function bindDesktopKeyboard(opts: DesktopEffectOptions): (() => void) | undefined {
  if (previewBlocksKeys(opts.isConfiguring, opts.presentations, opts.activePresentationId)) {
    return;
  }
  let composing = false;
  const { focused, navFocused } = focusHelpers(opts.fileViewOpen, opts.diffOpen);
  const onCompositionStart = () => {
    if (focused()) composing = true;
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    if (!composing) return;
    composing = false;
    if (!focused()) return;
    if (event.data) {
      const entry = opts.getSessionEntry(opts.getActiveSessionId());
      opts.sendPaste(entry?.term.bracketedPaste ? `\x1b[200~${event.data}\x1b[201~` : event.data);
    }
    opts.inputRef.current?.clear();
  };
  const dispatchBytes = (event: KeyboardEvent, bytes: string) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!applyDesktopKeyCommand(bytes, opts)) opts.sendKey(bytes);
  };
  // Capture-phase: grab nav keys before the webview/xterm can swallow them.
  // xterm's textarea owns focus while typing, and shouldForward skips TEXTAREA —
  // without this, arrows never reach the PTY (printable still works via input).
  const onNavCapture = (event: KeyboardEvent) => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (!keyNeedsFallback(event)) return;
    const key = resolveKeyboardKey(event);
    if (!isTerminalNavKey(key) || !navFocused()) return;
    const appCursor =
      opts.getSessionEntry(opts.getActiveSessionId())?.term.applicationCursor ?? false;
    const bytes = keyToBytes(event, appCursor, isMacDesktop, !!opts.getTerminalSelection());
    if (bytes == null) return;
    dispatchBytes(event, bytes);
  };
  const onKey = (event: KeyboardEvent) => {
    if (composing || event.isComposing || event.keyCode === 229 || !focused()) return;
    // Broken-key nav events already handled in capture. Resolvable nav keys
    // fall through here (this handler's own keyToBytes call below covers them).
    if (keyNeedsFallback(event) && isTerminalNavKey(resolveKeyboardKey(event))) return;
    const appCursor =
      opts.getSessionEntry(opts.getActiveSessionId())?.term.applicationCursor ?? false;
    const hasSelection = !!opts.getTerminalSelection();
    const bytes = keyToBytes(event, appCursor, isMacDesktop, hasSelection);
    if (bytes == null) return;
    // Body-focus fallback for printable/shortcuts — xterm textarea path uses onData.
    event.preventDefault();
    if (!applyDesktopKeyCommand(bytes, opts)) opts.sendKey(bytes);
  };
  window.addEventListener('keydown', onNavCapture, true);
  window.addEventListener('keydown', onKey);
  window.addEventListener('compositionstart', onCompositionStart);
  window.addEventListener('compositionend', onCompositionEnd);
  return () => {
    window.removeEventListener('keydown', onNavCapture, true);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('compositionstart', onCompositionStart);
    window.removeEventListener('compositionend', onCompositionEnd);
  };
}

export function bindDesktopContextMenu(opts: {
  isConfiguring: boolean;
  presentations: Presentation[];
  activePresentationId: string | null;
  setContextMenu: (position: { x: number; y: number }) => void;
}): (() => void) | undefined {
  if (previewBlocksKeys(opts.isConfiguring, opts.presentations, opts.activePresentationId)) {
    return;
  }
  const onContextMenu = (event: MouseEvent) => {
    const terminal = document.getElementById('tether-terminal');
    if (!terminal || !(event.target instanceof Node) || !terminal.contains(event.target)) return;
    event.preventDefault();
    opts.setContextMenu({ x: event.clientX, y: event.clientY });
  };
  document.addEventListener('contextmenu', onContextMenu);
  return () => document.removeEventListener('contextmenu', onContextMenu);
}

export function bindDesktopWindowFocus(opts: {
  setWindowFocused: (focused: boolean) => void;
  refreshSocketActivity: () => void;
}): (() => void) | undefined {
  if (!isDesktop || typeof window === 'undefined') return;
  const onFocus = () => {
    opts.setWindowFocused(true);
    opts.refreshSocketActivity();
  };
  const onBlur = () => {
    opts.setWindowFocused(false);
  };
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
  };
}

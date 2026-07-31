// biome-ignore-all lint/correctness/useExhaustiveDependencies: event subscriptions intentionally use stable transport refs.
import { useEffect, useRef } from 'react';
import type { TextInput } from 'react-native';
import { writeClipboard } from '../clipboard';
import { shouldForwardToTerminal, terminalAcceptsNavKeys } from '../desktopFocusGuard';
import {
  COPY,
  FONT_LARGER,
  FONT_SMALLER,
  isTerminalNavKey,
  keyToBytes,
  NEW_TERMINAL,
  PASTE,
  resolveKeyboardKey,
  SELECT_ALL,
} from '../desktopKeys';
import { notify as sendNativeNotification } from '../desktopNotify';
import { injectDragRegionStyles } from '../dragRegion';
import { isDesktop, isMacDesktop } from '../platform';
import type { Presentation } from '../presentations';
import type { SessionEntry } from '../sessionCache';

type Options = {
  isConfiguring: boolean;
  presentations: Presentation[];
  activePresentationId: string | null;
  fileViewOpen: boolean;
  diffOpen: boolean;
  getSessionEntry: (id: string) => SessionEntry | undefined;
  getActiveSessionId: () => string;
  getTerminalSelection: () => string;
  inputRef: React.MutableRefObject<TextInput | null>;
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

export function useDesktopEffects({
  isConfiguring,
  presentations,
  activePresentationId,
  fileViewOpen,
  diffOpen,
  getSessionEntry,
  getActiveSessionId,
  getTerminalSelection,
  inputRef,
  sendKey,
  sendPaste,
  handlePaste,
  selectAllTerminal,
  newTerminal,
  changeFontSize,
  setContextMenu,
  setWindowFocused,
  isWindowFocused,
  refreshSocketActivity,
  activePromptReturnCount,
}: Options) {
  useEffect(() => {
    if (isDesktop) injectDragRegionStyles();
  }, []);

  useEffect(() => {
    if (
      !isDesktop ||
      isConfiguring ||
      presentations.some((preview) => preview.id === activePresentationId)
    )
      return;
    let composing = false;
    const activeEl = () =>
      document.activeElement as
        | (HTMLElement & {
            isContentEditable?: boolean;
            classList?: DOMTokenList;
          })
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
    const onCompositionStart = () => {
      if (focused()) composing = true;
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      if (!composing) return;
      composing = false;
      if (!focused()) return;
      if (event.data) {
        const entry = getSessionEntry(getActiveSessionId());
        sendPaste(entry?.term.bracketedPaste ? `\x1b[200~${event.data}\x1b[201~` : event.data);
      }
      inputRef.current?.clear();
    };
    const dispatchBytes = (event: KeyboardEvent, bytes: string) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (bytes === COPY) {
        const text = getTerminalSelection();
        if (text) void writeClipboard(text);
        return;
      }
      if (bytes === PASTE) {
        void handlePaste();
        return;
      }
      if (bytes === SELECT_ALL) {
        selectAllTerminal();
        return;
      }
      if (bytes === NEW_TERMINAL) {
        newTerminal();
        return;
      }
      if (bytes === FONT_LARGER) {
        changeFontSize(1);
        return;
      }
      if (bytes === FONT_SMALLER) {
        changeFontSize(-1);
        return;
      }
      sendKey(bytes);
    };
    // Capture-phase: grab nav keys before the webview/xterm can swallow them.
    // xterm's textarea owns focus while typing, and shouldForward skips TEXTAREA —
    // without this, arrows never reach the PTY (printable still works via input).
    const onNavCapture = (event: KeyboardEvent) => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      const key = resolveKeyboardKey(event);
      if (!isTerminalNavKey(key) || !navFocused()) return;
      const appCursor = getSessionEntry(getActiveSessionId())?.term.applicationCursor ?? false;
      const bytes = keyToBytes(event, appCursor, isMacDesktop, !!getTerminalSelection());
      if (bytes == null) return;
      dispatchBytes(event, bytes);
    };
    const onKey = (event: KeyboardEvent) => {
      if (composing || event.isComposing || event.keyCode === 229 || !focused()) return;
      // Nav keys already handled in capture (including when xterm textarea focused).
      if (isTerminalNavKey(resolveKeyboardKey(event))) return;
      const appCursor = getSessionEntry(getActiveSessionId())?.term.applicationCursor ?? false;
      const hasSelection = !!getTerminalSelection();
      const bytes = keyToBytes(event, appCursor, isMacDesktop, hasSelection);
      if (bytes == null) return;
      // Body-focus fallback for printable/shortcuts — xterm textarea path uses onData.
      event.preventDefault();
      if (bytes === COPY) {
        const text = getTerminalSelection();
        if (text) void writeClipboard(text);
        return;
      }
      if (bytes === PASTE) {
        void handlePaste();
        return;
      }
      if (bytes === SELECT_ALL) {
        selectAllTerminal();
        return;
      }
      if (bytes === NEW_TERMINAL) {
        newTerminal();
        return;
      }
      if (bytes === FONT_LARGER) {
        changeFontSize(1);
        return;
      }
      if (bytes === FONT_SMALLER) {
        changeFontSize(-1);
        return;
      }
      sendKey(bytes);
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
  }, [isConfiguring, activePresentationId, presentations, fileViewOpen, diffOpen]);

  useEffect(() => {
    if (
      !isDesktop ||
      isConfiguring ||
      presentations.some((preview) => preview.id === activePresentationId)
    )
      return;
    const onContextMenu = (event: MouseEvent) => {
      const terminal = document.getElementById('tether-terminal');
      if (!terminal || !(event.target instanceof Node) || !terminal.contains(event.target)) return;
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY });
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, [isConfiguring, activePresentationId, presentations]);

  useEffect(() => {
    if (!isDesktop || typeof window === 'undefined') return;
    const onFocus = () => {
      setWindowFocused(true);
      refreshSocketActivity();
    };
    const onBlur = () => {
      setWindowFocused(false);
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const previousPromptCount = useRef(0);
  useEffect(() => {
    if (!isDesktop) return;
    const returned = activePromptReturnCount > previousPromptCount.current;
    previousPromptCount.current = activePromptReturnCount;
    if (returned && !isWindowFocused()) void sendNativeNotification('Tether', 'Command finished');
  }, [activePromptReturnCount]);
}

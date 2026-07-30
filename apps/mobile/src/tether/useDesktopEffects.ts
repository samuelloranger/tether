// biome-ignore-all lint/correctness/useExhaustiveDependencies: event subscriptions intentionally use stable transport refs.
import { useEffect, useRef } from 'react';
import type { TextInput } from 'react-native';
import { writeClipboard } from '../clipboard';
import { shouldForwardToTerminal } from '../desktopFocusGuard';
import {
  COPY,
  FONT_LARGER,
  FONT_SMALLER,
  keyToBytes,
  NEW_TERMINAL,
  PASTE,
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
    const focused = () =>
      shouldForwardToTerminal(
        document.activeElement as (HTMLElement & { isContentEditable?: boolean }) | null,
        document.activeElement === document.body,
        !fileViewOpen && !diffOpen,
      );
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
    const onKey = (event: KeyboardEvent) => {
      if (composing || event.isComposing || event.keyCode === 229 || !focused()) return;
      const appCursor = getSessionEntry(getActiveSessionId())?.term.applicationCursor ?? false;
      const hasSelection = !!getTerminalSelection();
      const bytes = keyToBytes(event, appCursor, isMacDesktop, hasSelection);
      if (bytes == null) return;
      event.preventDefault();
      // App shortcuts are primarily handled by TerminalView's xterm key handler
      // (textarea owns focus). This path is the body-focus fallback.
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
    window.addEventListener('keydown', onKey);
    window.addEventListener('compositionstart', onCompositionStart);
    window.addEventListener('compositionend', onCompositionEnd);
    return () => {
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

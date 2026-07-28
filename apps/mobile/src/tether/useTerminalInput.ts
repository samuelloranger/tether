import { useCallback, useRef, useState } from 'react';
import { applyBackspaceStreak, applyCtrlToKey, EMPTY_STREAK } from '../input';
import type { PtyInputSource } from '../ptyInput';
import type { SessionEntry } from '../sessionCache';

type Options = {
  send: (message: unknown) => void;
  mouseEnabledRef: React.MutableRefObject<boolean>;
  activeIdRef: React.MutableRefObject<string>;
  entryFor: (id: string) => SessionEntry;
};

/** The only byte-input path: source-specific Ctrl and accelerated-backspace rules live here. */
export function useTerminalInput({ send, mouseEnabledRef, activeIdRef, entryFor }: Options) {
  const [ctrlArmed, setCtrlArmedState] = useState(false);
  const ctrlArmedRef = useRef(false);
  const backspaceStreakRef = useRef(EMPTY_STREAK);
  const setCtrlArmed = useCallback((next: boolean | ((previous: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(ctrlArmedRef.current) : next;
    ctrlArmedRef.current = value;
    setCtrlArmedState(value);
  }, []);
  const sendToPty = (source: PtyInputSource, text: string) => {
    if (!text) return;
    const isMouseReport = text.startsWith('\x1b[<') || text.startsWith('\x1b[M');
    if (isMouseReport && !mouseEnabledRef.current) return;
    let bytes = text;
    if (!isMouseReport && (source === 'typed' || source === 'key')) {
      const ctrl = applyCtrlToKey(ctrlArmedRef.current, bytes);
      if (ctrl.consumed) setCtrlArmed(false);
      bytes = ctrl.bytes;
    }
    if (source === 'typed') {
      const tracked = applyBackspaceStreak(backspaceStreakRef.current, bytes, Date.now());
      backspaceStreakRef.current = tracked.streak;
      bytes = tracked.bytes;
    } else if (source === 'key' || source === 'paste') backspaceStreakRef.current = EMPTY_STREAK;
    send({ type: 'input', text: bytes });
  };
  const cursorSeq = (final: string) =>
    `\x1b${entryFor(activeIdRef.current).term.applicationCursor ? 'O' : '['}${final}`;
  return {
    ctrlArmed,
    setCtrlArmed,
    sendToPty,
    sendTyped: (text: string) => sendToPty('typed', text),
    sendKey: (text: string) => sendToPty('key', text),
    sendPaste: (text: string) => sendToPty('paste', text),
    sendProgram: (text: string) => sendToPty('program', text),
    cursorSeq,
  };
}

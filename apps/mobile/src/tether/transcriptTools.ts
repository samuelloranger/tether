import * as Haptics from 'expo-haptics';
import type { RefObject } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { readClipboard, writeClipboard } from '../clipboard';
import { notify } from '../dialog';
import { isDesktop } from '../platform';
import type { SessionEntry } from '../sessionCache';
import type { TerminalViewHandle } from '../TerminalView.types';
import type { RenderRow } from '../terminal';

export function rowsFromPlainText(text: string): RenderRow[] {
  return text.split('\n').map((line, i) => ({
    key: i,
    runs: [{ text: line, style: {} }],
    wrapped: false,
    links: [],
    promptStart: false,
  }));
}

export function usePresentationPoll(
  isConfiguring: boolean,
  refreshPresentations: () => void,
  serverIp: string,
  port: string,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: same host identity as the original poll
  useEffect(() => {
    if (isConfiguring) return;
    let iv: ReturnType<typeof setInterval> | null = null;
    let hidden = false;
    const tick = () => {
      if (!hidden) refreshPresentations();
    };
    const start = () => {
      if (iv) return;
      tick();
      iv = setInterval(tick, 4000);
    };
    const stop = () => {
      if (iv) {
        clearInterval(iv);
        iv = null;
      }
    };
    start();
    let onVis: (() => void) | undefined;
    if (isDesktop && typeof document !== 'undefined') {
      onVis = () => {
        hidden = document.hidden;
        if (!hidden) tick();
      };
      document.addEventListener('visibilitychange', onVis);
    }
    return () => {
      stop();
      if (onVis) document.removeEventListener('visibilitychange', onVis);
    };
  }, [isConfiguring, serverIp, port]);
}

export function useTranscriptSelection({
  searchQuery,
  terminalViewRef,
  getTerminalSelection,
  getSessionEntry,
  getActiveSessionId,
  sendPaste,
  setMenuOpen,
  setSearchQuery,
  setSelectionViewOpen,
}: {
  searchQuery: string;
  terminalViewRef: RefObject<TerminalViewHandle | null>;
  getTerminalSelection: () => string;
  getSessionEntry: (id: string) => SessionEntry | undefined;
  getActiveSessionId: () => string;
  sendPaste: (text: string) => void;
  setMenuOpen: (open: boolean) => void;
  setSearchQuery: (q: string) => void;
  setSelectionViewOpen: (open: boolean) => void;
}) {
  const [screen, setScreen] = useState<RenderRow[]>([]);
  const getFullText = async () => (await terminalViewRef.current?.snapshotText()) ?? '';
  const searchText = useMemo(() => {
    const full = screen
      .map((r) => r.runs.map((run) => run.text).join(''))
      .join('\n')
      .replace(/\n+$/, '');
    const q = searchQuery.trim().toLowerCase();
    if (!q) return full;
    return full
      .split('\n')
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n');
  }, [screen, searchQuery]);
  const jumpPrompt = (dir: 1 | -1) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    terminalViewRef.current?.jumpPrompt(dir);
  };
  const openSelectionView = async () => {
    setMenuOpen(false);
    setSearchQuery('');
    const text = await getFullText();
    if (!text) return;
    setScreen(rowsFromPlainText(text));
    setSelectionViewOpen(true);
  };
  const copySelection = async () => {
    const text = getTerminalSelection() || (await getFullText());
    if (text) await writeClipboard(text);
  };
  const selectAllTerminal = () => {
    terminalViewRef.current?.selectAll();
  };
  const handlePaste = async () => {
    let text = '';
    try {
      text = await readClipboard();
    } catch {
      void notify('Paste failed', 'Could not read the clipboard.', 'error');
      return;
    }
    if (!text) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const e = getSessionEntry(getActiveSessionId());
    sendPaste(e?.term.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text);
  };
  return {
    getFullText,
    searchText,
    jumpPrompt,
    openSelectionView,
    copySelection,
    selectAllTerminal,
    handlePaste,
  };
}

export function updateProgressLabel(progress: { done: number; total: number } | null): {
  upPct: number;
  upLabel: string;
} {
  const upPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;
  const upLabel =
    !progress || progress.total === 0
      ? 'Preparing…'
      : upPct >= 100
        ? 'Restarting…'
        : `${upPct}%  ${(progress.done / 1e6).toFixed(1)}/${(progress.total / 1e6).toFixed(1)} MB`;
  return { upPct, upLabel };
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewDiffSlot } from '../fetchReviewDiff';
import { summaryFingerprint } from '../gitReviewModel';
import type { LinkTarget } from '../links';
import type { SessionEntry } from '../sessionCache';
import {
  clearDiffView,
  closeReviewDiff,
  type GitReviewMutators,
  gitWriteOps,
  loadGitHistory,
  openReviewDiff,
  retryReviewFile,
  selectHistoryCommit,
  selectReviewFile,
  startReviewDiffLoad,
  syncOpenReview,
  toggleSideBySide,
} from './gitReviewActions';
import type { HostClient } from './hostClient';
import type { GitLogEntry } from './types';

const KEY_DIFF_SIDE_BY_SIDE = 'tether_diff_side_by_side';
export const KEY_GIT_DRAWER_LEFT_WIDTH = 'tether_git_drawer_left_width';

function bindMutators(
  refs: Pick<GitReviewMutators, 'diffSelectedPathRef' | 'diffModeRef' | 'reviewLoadGenRef'>,
  setters: Omit<GitReviewMutators, 'diffSelectedPathRef' | 'diffModeRef' | 'reviewLoadGenRef'>,
): GitReviewMutators {
  return { ...refs, ...setters };
}

function useGitReviewForm() {
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffSelectedPath, setDiffSelectedPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffMode, setDiffMode] = useState<'staged' | 'unstaged' | null>(null);
  const diffModeRef = useRef<'staged' | 'unstaged' | null>(null);
  const diffSelectedPathRef = useRef<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<GitLogEntry[] | null>(null);
  const [historyCommit, setHistoryCommit] = useState<{
    entry: GitLogEntry;
    diff: string | null;
    truncated: boolean;
  } | null>(null);
  const [diffSideBySide, setDiffSideBySide] = useState(false);
  const [diffImage, setDiffImage] = useState<{ old: string | null; new: string | null } | null>(
    null,
  );
  const [reviewDiffs, setReviewDiffs] = useState<Record<string, ReviewDiffSlot>>({});
  const reviewLoadGenRef = useRef(0);
  const mutators = bindMutators(
    { diffSelectedPathRef, diffModeRef, reviewLoadGenRef },
    {
      setDiffOpen,
      setDiffSelectedPath,
      setDiffText,
      setDiffTruncated,
      setDiffLoading,
      setDiffMode,
      setDiffImage,
      setHistoryCommit,
      setReviewDiffs,
      setHistoryEntries,
      setDiffSideBySide,
    },
  );
  const mut = useRef(mutators);
  mut.current = mutators;
  useEffect(() => {
    AsyncStorage.getItem(KEY_DIFF_SIDE_BY_SIDE)
      .then((value) => setDiffSideBySide(value === 'true'))
      .catch(() => {});
  }, []);
  return {
    diffOpen,
    diffSelectedPath,
    diffText,
    diffTruncated,
    diffLoading,
    diffMode,
    historyEntries,
    historyCommit,
    diffSideBySide,
    diffImage,
    reviewDiffs,
    mut,
  };
}

function useGitReviewLoaders(
  f: ReturnType<typeof useGitReviewForm>,
  client: HostClient,
  getActiveSessionId: () => string,
  entryFor: (id: string) => SessionEntry,
) {
  const closeDiff = useCallback(() => closeReviewDiff(f.mut.current), [f.mut]);
  const deselectDiffFile = useCallback(() => clearDiffView(f.mut.current), [f.mut]);
  const selectDiffFile = useCallback(
    (filePath: string, mode?: 'staged' | 'unstaged') =>
      selectReviewFile(f.mut.current, {
        client,
        sessionId: getActiveSessionId(),
        filePath,
        mode,
        entry: entryFor(getActiveSessionId()),
      }),
    [client, entryFor, f.mut, getActiveSessionId],
  );
  const loadReviewDiffs = useCallback(() => {
    startReviewDiffLoad(
      f.mut.current,
      client,
      getActiveSessionId(),
      entryFor(getActiveSessionId()),
    );
  }, [client, entryFor, f.mut, getActiveSessionId]);
  const retryReviewDiff = useCallback(
    (mode: 'staged' | 'unstaged', path: string) => {
      retryReviewFile(
        f.mut.current,
        client,
        getActiveSessionId(),
        entryFor(getActiveSessionId()),
        mode,
        path,
      );
    },
    [client, entryFor, f.mut, getActiveSessionId],
  );
  const openDiff = useCallback(() => openReviewDiff(f.mut.current), [f.mut]);
  const refreshOpenDiff = useCallback(() => {
    const path = f.mut.current.diffSelectedPathRef.current;
    const mode = f.mut.current.diffModeRef.current;
    if (path) void selectDiffFile(path, mode ?? undefined);
  }, [f.mut, selectDiffFile]);
  return {
    closeDiff,
    deselectDiffFile,
    selectDiffFile,
    loadReviewDiffs,
    retryReviewDiff,
    openDiff,
    refreshOpenDiff,
  };
}

function useGitReviewSync(
  f: ReturnType<typeof useGitReviewForm>,
  loaders: ReturnType<typeof useGitReviewLoaders>,
  changeSummary: SessionEntry['diffSummary'],
) {
  const changeSummaryFp = summaryFingerprint(changeSummary);
  const loadReviewDiffsRef = useRef(loaders.loadReviewDiffs);
  loadReviewDiffsRef.current = loaders.loadReviewDiffs;
  const refreshOpenDiffRef = useRef(loaders.refreshOpenDiff);
  refreshOpenDiffRef.current = loaders.refreshOpenDiff;
  const selectDiffFileRef = useRef(loaders.selectDiffFile);
  selectDiffFileRef.current = loaders.selectDiffFile;
  const deselectDiffFileRef = useRef(loaders.deselectDiffFile);
  deselectDiffFileRef.current = loaders.deselectDiffFile;
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaders via refs; summary via fingerprint
  useEffect(() => {
    if (!f.diffOpen) return;
    syncOpenReview({
      changeSummary,
      path: f.mut.current.diffSelectedPathRef.current,
      mode: f.mut.current.diffModeRef.current,
      loadReviewDiffs: () => loadReviewDiffsRef.current(),
      refreshOpenDiff: () => refreshOpenDiffRef.current(),
      selectDiffFile: (path, mode) => void selectDiffFileRef.current(path, mode),
      deselectDiffFile: () => deselectDiffFileRef.current(),
    });
  }, [f.diffOpen, changeSummaryFp]);
}

function reviewPublic(
  f: ReturnType<typeof useGitReviewForm>,
  loaders: ReturnType<typeof useGitReviewLoaders>,
  writes: ReturnType<typeof gitWriteOps>,
  extra: {
    activeEntry: SessionEntry;
    client: HostClient;
    getActiveSessionId: () => string;
    openFile: (target: LinkTarget) => Promise<void>;
  },
) {
  const m = f.mut.current;
  return {
    diffOpen: f.diffOpen,
    closeDiff: loaders.closeDiff,
    changeSummary: extra.activeEntry.diffSummary,
    repoStatus: extra.activeEntry.repoStatus,
    diffSelectedPath: f.diffSelectedPath,
    diffText: f.diffText,
    diffTruncated: f.diffTruncated,
    diffLoading: f.diffLoading,
    diffImage: f.diffImage,
    openDiff: loaders.openDiff,
    selectDiffFile: loaders.selectDiffFile,
    deselectDiffFile: loaders.deselectDiffFile,
    diffMode: f.diffMode,
    ...writes,
    historyEntries: f.historyEntries,
    historyCommit: f.historyCommit,
    loadGitLog: () => loadGitHistory(m.setHistoryEntries, extra.client, extra.getActiveSessionId()),
    selectCommit: (entry: GitLogEntry | null) =>
      selectHistoryCommit(m.setHistoryCommit, extra.client, extra.getActiveSessionId(), entry),
    diffSideBySide: f.diffSideBySide,
    toggleDiffSideBySide: () => toggleSideBySide(m.setDiffSideBySide, KEY_DIFF_SIDE_BY_SIDE),
    gitDrawerLeftWidthKey: KEY_GIT_DRAWER_LEFT_WIDTH,
    reviewDiffs: f.reviewDiffs,
    loadReviewDiffs: loaders.loadReviewDiffs,
    retryReviewDiff: loaders.retryReviewDiff,
    openDiffFileLine: (path: string, line: number) =>
      void extra.openFile({ kind: 'file', path, line }),
    activeEntry: extra.activeEntry,
  };
}

export function useGitReview({
  client,
  activeId,
  getActiveSessionId,
  entryFor,
  getSessionEntry,
  openFile,
}: {
  client: HostClient;
  activeId: string;
  getActiveSessionId: () => string;
  entryFor: (id: string) => SessionEntry;
  getSessionEntry: (id: string) => SessionEntry | undefined;
  openFile: (target: LinkTarget) => Promise<void>;
}) {
  const f = useGitReviewForm();
  const loaders = useGitReviewLoaders(f, client, getActiveSessionId, entryFor);
  const activeEntry = getSessionEntry(activeId) ?? entryFor(activeId);
  useGitReviewSync(f, loaders, activeEntry.diffSummary);
  return reviewPublic(f, loaders, gitWriteOps(f.mut.current, client, getActiveSessionId), {
    activeEntry,
    client,
    getActiveSessionId,
    openFile,
  });
}

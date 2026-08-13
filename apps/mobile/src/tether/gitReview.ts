import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { notify } from '../dialog';
import type { ReviewDiffSlot } from '../fetchReviewDiff';
import { reviewDiffKey, reviewFileEntries, summaryFingerprint } from '../gitReviewModel';
import type { LinkTarget } from '../links';
import type { SessionEntry } from '../sessionCache';
import {
  beginReviewDiffLoad,
  confirmDiscardAll,
  confirmDiscardFile,
  confirmUndoCommit,
  fillReviewDiffs,
  gitFetch,
  gitPost,
  loadCommitDiff,
  loadSelectedDiff,
  notifyGitOp,
  retryOneReviewDiff,
} from './gitReviewOps';
import type { HostClient } from './hostClient';
import type { GitLogEntry } from './types';

const KEY_DIFF_SIDE_BY_SIDE = 'tether_diff_side_by_side';
export const KEY_GIT_DRAWER_LEFT_WIDTH = 'tether_git_drawer_left_width';

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

  useEffect(() => {
    AsyncStorage.getItem(KEY_DIFF_SIDE_BY_SIDE)
      .then((value) => setDiffSideBySide(value === 'true'))
      .catch(() => {});
  }, []);

  const closeDiff = useCallback(() => {
    reviewLoadGenRef.current += 1;
    setDiffOpen(false);
    setDiffSelectedPath(null);
    diffSelectedPathRef.current = null;
    setDiffMode(null);
    diffModeRef.current = null;
    setDiffText(null);
    setDiffTruncated(false);
    setDiffImage(null);
    setHistoryCommit(null);
    setReviewDiffs({});
  }, []);
  const deselectDiffFile = useCallback(() => {
    setDiffSelectedPath(null);
    diffSelectedPathRef.current = null;
    setDiffMode(null);
    diffModeRef.current = null;
    setDiffText(null);
    setDiffTruncated(false);
    setDiffImage(null);
  }, []);
  const selectDiffFile = useCallback(
    async (filePath: string, mode?: 'staged' | 'unstaged') => {
      setDiffSelectedPath(filePath);
      diffSelectedPathRef.current = filePath;
      setDiffMode(mode ?? null);
      diffModeRef.current = mode ?? null;
      setDiffText(null);
      setDiffTruncated(false);
      setDiffImage(null);
      setDiffLoading(true);
      try {
        const loaded = await loadSelectedDiff({
          client,
          sessionId: getActiveSessionId(),
          filePath,
          mode,
          entry: entryFor(getActiveSessionId()),
        });
        if (loaded.kind === 'image') setDiffImage({ old: loaded.old, new: loaded.new });
        else {
          setDiffText(loaded.diff);
          setDiffTruncated(loaded.truncated);
        }
      } catch (error) {
        void notify('Could not load diff', String(error), 'error');
      } finally {
        setDiffLoading(false);
      }
    },
    [client, entryFor, getActiveSessionId],
  );
  const loadReviewDiffs = useCallback(() => {
    const sessionId = getActiveSessionId();
    const gen = ++reviewLoadGenRef.current;
    setReviewDiffs(beginReviewDiffLoad(entryFor(sessionId)));
    void fillReviewDiffs({
      client,
      sessionId,
      entry: entryFor(sessionId),
      gen,
      currentGen: () => reviewLoadGenRef.current,
      setSlot: (key, slot) => setReviewDiffs((prev) => ({ ...prev, [key]: slot })),
    });
  }, [client, entryFor, getActiveSessionId]);
  const retryReviewDiff = useCallback(
    (mode: 'staged' | 'unstaged', path: string) => {
      const key = reviewDiffKey(mode, path);
      const gen = reviewLoadGenRef.current;
      setReviewDiffs((prev) => ({ ...prev, [key]: { status: 'loading' } }));
      void retryOneReviewDiff({
        client,
        sessionId: getActiveSessionId(),
        entry: entryFor(getActiveSessionId()),
        mode,
        path,
      }).then((slot) => {
        if (!slot || reviewLoadGenRef.current !== gen) return;
        setReviewDiffs((prev) => ({ ...prev, [key]: slot }));
      });
    },
    [client, entryFor, getActiveSessionId],
  );
  const openDiff = useCallback(() => {
    setDiffOpen(true);
    setDiffSelectedPath(null);
    diffSelectedPathRef.current = null;
    setDiffMode(null);
    diffModeRef.current = null;
    setDiffText(null);
    setDiffTruncated(false);
    setDiffImage(null);
    setHistoryCommit(null);
  }, []);
  const refreshOpenDiff = useCallback(() => {
    const path = diffSelectedPathRef.current;
    const mode = diffModeRef.current;
    if (path) void selectDiffFile(path, mode ?? undefined);
  }, [selectDiffFile]);
  const op = (route: string, payload: unknown, fail: string) =>
    notifyGitOp(fail, () => gitPost(client, getActiveSessionId(), route, payload));
  const stageFile = (path: string) => void op('stage', { path }, 'Stage failed');
  const unstageFile = (path: string) => void op('unstage', { path }, 'Unstage failed');
  const discardFile = async (path: string) => {
    if (!(await confirmDiscardFile(path))) return;
    const ok = await op('discard', { path }, 'Discard failed');
    if (ok && diffSelectedPathRef.current === path) deselectDiffFile();
  };
  const stageAllFiles = () => void op('stage-all', {}, 'Stage all failed');
  const unstageAllFiles = () => void op('unstage-all', {}, 'Unstage all failed');
  const discardAllFiles = async () => {
    if (!(await confirmDiscardAll())) return;
    const ok = await op('discard-all', {}, 'Discard all failed');
    if (ok) deselectDiffFile();
  };
  const toggleHunk = (path: string, hunkIndex: number, staged: boolean) =>
    void op(
      staged ? 'unstage-hunk' : 'stage-hunk',
      { path, hunkIndex },
      staged ? 'Unstage hunk failed' : 'Stage hunk failed',
    );
  const commitStagedChanges = async (message: string, amend = false) =>
    op(
      'commit',
      { message, ...(amend ? { amend: true } : {}) },
      amend ? 'Amend failed' : 'Commit failed',
    );
  const undoLastCommit = async () => {
    if (!(await confirmUndoCommit())) return;
    await op('undo-commit', {}, 'Undo commit failed');
  };
  const pushChanges = () => void op('push', {}, 'Push failed');
  const openDiffFileLine = (path: string, line: number) => {
    void openFile({ kind: 'file', path, line });
  };
  const loadGitLog = async () => {
    try {
      setHistoryEntries(
        (await gitFetch(client, getActiveSessionId(), 'log')) as unknown as GitLogEntry[],
      );
    } catch (error) {
      setHistoryEntries([]);
      void notify('Could not load history', String(error), 'error');
    }
  };
  const selectCommit = async (entry: GitLogEntry | null) => {
    if (!entry) {
      setHistoryCommit(null);
      return;
    }
    setHistoryCommit({ entry, diff: null, truncated: false });
    try {
      setHistoryCommit(await loadCommitDiff(client, getActiveSessionId(), entry));
    } catch (error) {
      setHistoryCommit(null);
      void notify('Could not load commit', String(error), 'error');
    }
  };
  const toggleDiffSideBySide = () => {
    setDiffSideBySide((prev) => {
      AsyncStorage.setItem(KEY_DIFF_SIDE_BY_SIDE, String(!prev));
      return !prev;
    });
  };

  const activeEntry = getSessionEntry(activeId) ?? entryFor(activeId);
  const changeSummary = activeEntry.diffSummary;
  const repoStatus = activeEntry.repoStatus;
  const changeSummaryFp = summaryFingerprint(changeSummary);
  const loadReviewDiffsRef = useRef(loadReviewDiffs);
  loadReviewDiffsRef.current = loadReviewDiffs;
  const refreshOpenDiffRef = useRef(refreshOpenDiff);
  refreshOpenDiffRef.current = refreshOpenDiff;
  const selectDiffFileRef = useRef(selectDiffFile);
  selectDiffFileRef.current = selectDiffFile;
  const deselectDiffFileRef = useRef(deselectDiffFile);
  deselectDiffFileRef.current = deselectDiffFile;
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaders via refs; summary via fingerprint
  useEffect(() => {
    if (!diffOpen) return;
    loadReviewDiffsRef.current();
    const path = diffSelectedPathRef.current;
    const mode = diffModeRef.current;
    if (!path) return;
    const entries = reviewFileEntries(changeSummary);
    if (entries.some((e) => e.path === path && e.mode === mode)) {
      refreshOpenDiffRef.current();
      return;
    }
    const moved = entries.find((e) => e.path === path);
    if (moved) void selectDiffFileRef.current(moved.path, moved.mode);
    else deselectDiffFileRef.current();
  }, [diffOpen, changeSummaryFp]);

  return {
    diffOpen,
    closeDiff,
    changeSummary,
    repoStatus,
    diffSelectedPath,
    diffText,
    diffTruncated,
    diffLoading,
    diffImage,
    openDiff,
    selectDiffFile,
    deselectDiffFile,
    diffMode,
    stageFile,
    unstageFile,
    discardFile,
    stageAllFiles,
    unstageAllFiles,
    discardAllFiles,
    toggleHunk,
    commitStagedChanges,
    undoLastCommit,
    pushChanges,
    historyEntries,
    historyCommit,
    loadGitLog,
    selectCommit,
    diffSideBySide,
    toggleDiffSideBySide,
    gitDrawerLeftWidthKey: KEY_GIT_DRAWER_LEFT_WIDTH,
    reviewDiffs,
    loadReviewDiffs,
    retryReviewDiff,
    openDiffFileLine,
    activeEntry,
  };
}

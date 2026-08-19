import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { notify } from '../dialog';
import type { ReviewDiffSlot } from '../fetchReviewDiff';
import { reviewDiffKey, reviewFileEntries } from '../gitReviewModel';
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

export type HistoryCommit = {
  entry: GitLogEntry;
  diff: string | null;
  truncated: boolean;
} | null;

export type GitReviewMutators = {
  setDiffOpen: (value: boolean) => void;
  setDiffSelectedPath: (value: string | null) => void;
  setDiffText: (value: string | null) => void;
  setDiffTruncated: (value: boolean) => void;
  setDiffLoading: (value: boolean) => void;
  setDiffMode: (value: 'staged' | 'unstaged' | null) => void;
  setDiffImage: (value: { old: string | null; new: string | null } | null) => void;
  setHistoryCommit: (value: HistoryCommit) => void;
  setReviewDiffs: Dispatch<SetStateAction<Record<string, ReviewDiffSlot>>>;
  setHistoryEntries: (value: GitLogEntry[] | null) => void;
  setDiffSideBySide: Dispatch<SetStateAction<boolean>>;
  diffSelectedPathRef: MutableRefObject<string | null>;
  diffModeRef: MutableRefObject<'staged' | 'unstaged' | null>;
  reviewLoadGenRef: MutableRefObject<number>;
};

export function clearDiffView(s: GitReviewMutators) {
  s.setDiffSelectedPath(null);
  s.diffSelectedPathRef.current = null;
  s.setDiffMode(null);
  s.diffModeRef.current = null;
  s.setDiffText(null);
  s.setDiffTruncated(false);
  s.setDiffImage(null);
}

export function closeReviewDiff(s: GitReviewMutators) {
  s.reviewLoadGenRef.current += 1;
  s.setDiffOpen(false);
  clearDiffView(s);
  s.setHistoryCommit(null);
  s.setReviewDiffs({});
}

export function openReviewDiff(s: GitReviewMutators) {
  s.setDiffOpen(true);
  clearDiffView(s);
  s.setHistoryCommit(null);
}

export async function selectReviewFile(
  s: GitReviewMutators,
  opts: {
    client: HostClient;
    sessionId: string;
    filePath: string;
    mode?: 'staged' | 'unstaged';
    entry: SessionEntry;
  },
) {
  s.setDiffSelectedPath(opts.filePath);
  s.diffSelectedPathRef.current = opts.filePath;
  s.setDiffMode(opts.mode ?? null);
  s.diffModeRef.current = opts.mode ?? null;
  s.setDiffText(null);
  s.setDiffTruncated(false);
  s.setDiffImage(null);
  s.setDiffLoading(true);
  try {
    const loaded = await loadSelectedDiff(opts);
    if (loaded.kind === 'image') s.setDiffImage({ old: loaded.old, new: loaded.new });
    else {
      s.setDiffText(loaded.diff);
      s.setDiffTruncated(loaded.truncated);
    }
  } catch (error) {
    void notify('Could not load diff', String(error), 'error');
  } finally {
    s.setDiffLoading(false);
  }
}

export function startReviewDiffLoad(
  s: GitReviewMutators,
  client: HostClient,
  sessionId: string,
  entry: SessionEntry,
) {
  const gen = ++s.reviewLoadGenRef.current;
  s.setReviewDiffs(beginReviewDiffLoad(entry));
  void fillReviewDiffs({
    client,
    sessionId,
    entry,
    gen,
    currentGen: () => s.reviewLoadGenRef.current,
    setSlot: (key, slot) => s.setReviewDiffs((prev) => ({ ...prev, [key]: slot })),
  });
}

export function retryReviewFile(
  s: GitReviewMutators,
  client: HostClient,
  sessionId: string,
  entry: SessionEntry,
  mode: 'staged' | 'unstaged',
  path: string,
) {
  // Bail before showing the spinner: a stale path (dropped from the summary by a
  // diff frame) must stay a no-op rather than spin forever.
  if (!entry.diffSummary.files.some((f) => f.path === path)) return;
  const key = reviewDiffKey(mode, path);
  const gen = s.reviewLoadGenRef.current;
  s.setReviewDiffs((prev) => ({ ...prev, [key]: { status: 'loading' } }));
  void retryOneReviewDiff({ client, sessionId, entry, mode, path }).then((slot) => {
    if (!slot || s.reviewLoadGenRef.current !== gen) return;
    s.setReviewDiffs((prev) => ({ ...prev, [key]: slot }));
  });
}

export function gitWriteOps(
  s: GitReviewMutators,
  client: HostClient,
  getActiveSessionId: () => string,
) {
  const op = (route: string, payload: unknown, fail: string) =>
    notifyGitOp(fail, () => gitPost(client, getActiveSessionId(), route, payload));
  return {
    stageFile: (path: string) => void op('stage', { path }, 'Stage failed'),
    unstageFile: (path: string) => void op('unstage', { path }, 'Unstage failed'),
    discardFile: async (path: string) => {
      if (!(await confirmDiscardFile(path))) return;
      const ok = await op('discard', { path }, 'Discard failed');
      if (ok && s.diffSelectedPathRef.current === path) clearDiffView(s);
    },
    stageAllFiles: () => void op('stage-all', {}, 'Stage all failed'),
    unstageAllFiles: () => void op('unstage-all', {}, 'Unstage all failed'),
    discardAllFiles: async () => {
      if (!(await confirmDiscardAll())) return;
      const ok = await op('discard-all', {}, 'Discard all failed');
      if (ok) clearDiffView(s);
    },
    toggleHunk: (path: string, hunkIndex: number, staged: boolean) =>
      void op(
        staged ? 'unstage-hunk' : 'stage-hunk',
        { path, hunkIndex },
        staged ? 'Unstage hunk failed' : 'Stage hunk failed',
      ),
    commitStagedChanges: (message: string, amend = false) =>
      op(
        'commit',
        { message, ...(amend ? { amend: true } : {}) },
        amend ? 'Amend failed' : 'Commit failed',
      ),
    undoLastCommit: async () => {
      if (!(await confirmUndoCommit())) return;
      await op('undo-commit', {}, 'Undo commit failed');
    },
    pushChanges: () => void op('push', {}, 'Push failed'),
  };
}

export async function loadGitHistory(
  setHistoryEntries: (value: GitLogEntry[] | null) => void,
  client: HostClient,
  sessionId: string,
) {
  try {
    setHistoryEntries((await gitFetch(client, sessionId, 'log')) as unknown as GitLogEntry[]);
  } catch (error) {
    setHistoryEntries([]);
    void notify('Could not load history', String(error), 'error');
  }
}

export async function selectHistoryCommit(
  setHistoryCommit: (value: HistoryCommit) => void,
  client: HostClient,
  sessionId: string,
  entry: GitLogEntry | null,
) {
  if (!entry) {
    setHistoryCommit(null);
    return;
  }
  setHistoryCommit({ entry, diff: null, truncated: false });
  try {
    setHistoryCommit(await loadCommitDiff(client, sessionId, entry));
  } catch (error) {
    setHistoryCommit(null);
    void notify('Could not load commit', String(error), 'error');
  }
}

export function toggleSideBySide(
  setDiffSideBySide: Dispatch<SetStateAction<boolean>>,
  storageKey: string,
) {
  setDiffSideBySide((prev) => {
    AsyncStorage.setItem(storageKey, String(!prev));
    return !prev;
  });
}

export function syncOpenReview(opts: {
  changeSummary: SessionEntry['diffSummary'];
  path: string | null;
  mode: 'staged' | 'unstaged' | null;
  loadReviewDiffs: () => void;
  refreshOpenDiff: () => void;
  selectDiffFile: (path: string, mode?: 'staged' | 'unstaged') => void;
  deselectDiffFile: () => void;
}) {
  opts.loadReviewDiffs();
  if (!opts.path) return;
  const entries = reviewFileEntries(opts.changeSummary);
  if (entries.some((e) => e.path === opts.path && e.mode === opts.mode)) {
    opts.refreshOpenDiff();
    return;
  }
  const moved = entries.find((e) => e.path === opts.path);
  if (moved) opts.selectDiffFile(moved.path, moved.mode);
  else opts.deselectDiffFile();
}

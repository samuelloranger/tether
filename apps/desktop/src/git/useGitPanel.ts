import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bytesToDataUrl,
  canPushHead,
  canRewriteHead,
  coreDiffParse,
  coreGitCommit,
  coreGitCommitDiff,
  coreGitDiff,
  coreGitDiffFile,
  coreGitDiscard,
  coreGitDiscardAll,
  coreGitLog,
  coreGitPush,
  coreGitStage,
  coreGitStageAll,
  coreGitStageHunk,
  coreGitStatus,
  coreGitSummary,
  coreGitUndoCommit,
  coreGitUnstage,
  coreGitUnstageAll,
  coreGitUnstageHunk,
  type DiffSummary,
  type GitLogEntry,
  groupSummary,
  isImagePath,
  type ParsedDiffView,
  type RepoStatus,
} from './gitApi';

const EMPTY_SUMMARY: DiffSummary = { files: [] };
const EMPTY_STATUS: RepoStatus = {
  branch: '',
  shortSha: '',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
};

export type DiffMode = 'staged' | 'unstaged' | null;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: git panel owns summary/diff/history actions
export function useGitPanel(hostId: string | null, sessionId: string | null, open: boolean) {
  const [summary, setSummary] = useState<DiffSummary>(EMPTY_SUMMARY);
  const [repoStatus, setRepoStatus] = useState<RepoStatus>(EMPTY_STATUS);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffParsed, setDiffParsed] = useState<ParsedDiffView | null>(null);
  const [diffImage, setDiffImage] = useState<{ old: string | null; new: string | null } | null>(
    null,
  );
  const [historyEntries, setHistoryEntries] = useState<GitLogEntry[] | null>(null);
  const [historyCommit, setHistoryCommit] = useState<{
    entry: GitLogEntry;
    diff: string | null;
    truncated: boolean;
    parsed: ParsedDiffView | null;
  } | null>(null);
  const [sideBySide, setSideBySide] = useState(false);
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!hostId || !sessionId) return;
    try {
      const [nextSummary, nextStatus] = await Promise.all([
        coreGitSummary(hostId, sessionId),
        coreGitStatus(hostId, sessionId),
      ]);
      setSummary(nextSummary);
      setRepoStatus(nextStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [hostId, sessionId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  useEffect(() => {
    if (!open) {
      setSelectedPath(null);
      setDiffMode(null);
      setDiffText(null);
      setDiffParsed(null);
      setDiffImage(null);
      setHistoryCommit(null);
    }
  }, [open]);

  const loadFileDiff = useCallback(
    async (path: string, mode?: 'staged' | 'unstaged') => {
      if (!hostId || !sessionId) return;
      const gen = ++genRef.current;
      setDiffLoading(true);
      setDiffText(null);
      setDiffParsed(null);
      setDiffImage(null);
      setSelectedPath(path);
      setDiffMode(mode ?? null);
      try {
        const file = summary.files.find(
          (entry) =>
            entry.path === path &&
            (mode == null || (mode === 'staged' ? entry.staged === true : entry.staged !== true)),
        );
        if (file?.binary && isImagePath(path)) {
          const [oldBytes, newBytes] = await Promise.all([
            coreGitDiffFile(hostId, sessionId, path, 'old'),
            coreGitDiffFile(hostId, sessionId, path, 'new'),
          ]);
          if (gen !== genRef.current) return;
          setDiffImage({
            old: oldBytes ? bytesToDataUrl(oldBytes) : null,
            new: newBytes ? bytesToDataUrl(newBytes) : null,
          });
        } else {
          const payload = await coreGitDiff(hostId, sessionId, path, mode);
          if (gen !== genRef.current) return;
          setDiffText(payload.diff);
          setDiffTruncated(payload.truncated);
          setDiffParsed(await coreDiffParse(payload.diff));
        }
      } catch (err) {
        if (gen !== genRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (gen === genRef.current) setDiffLoading(false);
      }
    },
    [hostId, sessionId, summary.files],
  );

  const runOp = useCallback(
    async (op: () => Promise<void>) => {
      try {
        await op();
        await refresh();
        if (selectedPath) await loadFileDiff(selectedPath, diffMode ?? undefined);
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [diffMode, loadFileDiff, refresh, selectedPath],
  );

  const groups = groupSummary(summary);

  return {
    summary,
    groups,
    repoStatus,
    error,
    selectedPath,
    diffMode,
    diffText,
    diffTruncated,
    diffLoading,
    diffParsed,
    diffImage,
    historyEntries,
    historyCommit,
    sideBySide,
    canAmend: canRewriteHead(repoStatus),
    canPush: canPushHead(repoStatus),
    setSideBySide,
    refresh,
    selectFile: (path: string, mode?: 'staged' | 'unstaged') => void loadFileDiff(path, mode),
    deselectFile: () => {
      setSelectedPath(null);
      setDiffMode(null);
      setDiffText(null);
      setDiffParsed(null);
      setDiffImage(null);
    },
    stageFile: (path: string) =>
      hostId && sessionId
        ? runOp(() => coreGitStage(hostId, sessionId, path))
        : Promise.resolve(false),
    unstageFile: (path: string) =>
      hostId && sessionId
        ? runOp(() => coreGitUnstage(hostId, sessionId, path))
        : Promise.resolve(false),
    discardFile: (path: string) => {
      if (!window.confirm(`Discard changes to ${path}?`)) return Promise.resolve(false);
      return hostId && sessionId
        ? runOp(() => coreGitDiscard(hostId, sessionId, path))
        : Promise.resolve(false);
    },
    stageAll: () =>
      hostId && sessionId
        ? runOp(() => coreGitStageAll(hostId, sessionId))
        : Promise.resolve(false),
    unstageAll: () =>
      hostId && sessionId
        ? runOp(() => coreGitUnstageAll(hostId, sessionId))
        : Promise.resolve(false),
    discardAll: () => {
      if (!window.confirm('Discard all unstaged changes?')) return Promise.resolve(false);
      return hostId && sessionId
        ? runOp(() => coreGitDiscardAll(hostId, sessionId))
        : Promise.resolve(false);
    },
    toggleHunk: (path: string, hunkIndex: number, staged: boolean) => {
      if (!hostId || !sessionId) return Promise.resolve(false);
      return runOp(() =>
        staged
          ? coreGitUnstageHunk(hostId, sessionId, path, hunkIndex)
          : coreGitStageHunk(hostId, sessionId, path, hunkIndex),
      );
    },
    commit: async (message: string) => {
      if (!hostId || !sessionId) return false;
      const ok = await runOp(() => coreGitCommit(hostId, sessionId, message, false));
      return ok;
    },
    amend: async (message: string) => {
      if (!hostId || !sessionId) return false;
      return runOp(() => coreGitCommit(hostId, sessionId, message, true));
    },
    undoCommit: () => {
      if (!window.confirm('Undo last commit? Changes stay staged.')) return;
      if (!hostId || !sessionId) return;
      void runOp(() => coreGitUndoCommit(hostId, sessionId));
    },
    push: () => {
      if (!hostId || !sessionId) return;
      void runOp(() => coreGitPush(hostId, sessionId));
    },
    loadHistory: async () => {
      if (!hostId || !sessionId) return;
      try {
        setHistoryEntries(await coreGitLog(hostId, sessionId));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    selectCommit: async (entry: GitLogEntry | null) => {
      if (!entry) {
        setHistoryCommit(null);
        return;
      }
      if (!hostId || !sessionId) return;
      setDiffLoading(true);
      try {
        const payload = await coreGitCommitDiff(hostId, sessionId, entry.sha);
        const parsed = await coreDiffParse(payload.diff);
        setHistoryCommit({
          entry,
          diff: payload.diff,
          truncated: payload.truncated,
          parsed,
        });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDiffLoading(false);
      }
    },
  };
}

export type GitPanelState = ReturnType<typeof useGitPanel>;

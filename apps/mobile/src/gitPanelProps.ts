import type { DiffSummary } from './diffModel';
import type { RepoStatus } from './gitStatusModel';
import type { GitLogEntry } from './tether/types';

/** Actions + history props shared by GitDrawer and GitReview. */
export type GitPanelSharedProps = {
  summary: DiffSummary;
  onBack: () => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onDiscardFile: (path: string) => void;
  onToggleHunk: (path: string, hunkIndex: number, staged: boolean) => void;
  onCommit: (message: string) => Promise<boolean>;
  onAmend: (message: string) => Promise<boolean>;
  onUndoCommit: () => void;
  onPush: () => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardAll: () => void;
  onOpenLine: (path: string, line: number) => void;
  repoStatus: RepoStatus;
  historyEntries: GitLogEntry[] | null;
  historyCommit: { entry: GitLogEntry; diff: string | null; truncated: boolean } | null;
  onLoadHistory: () => void;
  onSelectCommit: (entry: GitLogEntry | null) => void;
};

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { normalizeInvokeError } from '../invokeError';

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw normalizeInvokeError(error);
  }
}

export type DiffFileStat = {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  staged?: boolean;
  untracked?: boolean;
};

export type DiffSummary = { files: DiffFileStat[] };

export type RepoStatus = {
  branch: string;
  shortSha: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type GitLogEntry = {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
};

export type DiffPayload = { diff: string; truncated: boolean };

export type DiffLineKind = 'add' | 'remove' | 'meta' | 'context';

export type DiffLine = {
  text: string;
  kind: DiffLineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

export type SideBySideRow = {
  left: DiffLine | null;
  right: DiffLine | null;
  span: boolean;
};

export type ParsedDiffView = {
  lines: DiffLine[];
  hunkIndices: Array<number | null>;
  rows: SideBySideRow[];
};

export type DiffFileBytes = { base64: string; contentType: string };

export async function coreGitSummary(hostId: string, sessionId: string): Promise<DiffSummary> {
  return invoke('core_git_summary', { hostId, sessionId });
}

export async function coreGitDiff(
  hostId: string,
  sessionId: string,
  path?: string,
  mode?: 'staged' | 'unstaged',
): Promise<DiffPayload> {
  return invoke('core_git_diff', {
    hostId,
    sessionId,
    path: path ?? null,
    mode: mode ?? null,
  });
}

export async function coreGitDiffFile(
  hostId: string,
  sessionId: string,
  path: string,
  side: 'old' | 'new',
): Promise<DiffFileBytes | null> {
  return invoke('core_git_diff_file', { hostId, sessionId, path, side });
}

export async function coreGitStatus(hostId: string, sessionId: string): Promise<RepoStatus> {
  return invoke('core_git_status', { hostId, sessionId });
}

export async function coreGitLog(
  hostId: string,
  sessionId: string,
  limit = 50,
): Promise<GitLogEntry[]> {
  return invoke('core_git_log', { hostId, sessionId, limit });
}

export async function coreGitCommitDiff(
  hostId: string,
  sessionId: string,
  sha: string,
  path?: string,
): Promise<DiffPayload> {
  return invoke('core_git_commit_diff', {
    hostId,
    sessionId,
    sha,
    path: path ?? null,
  });
}

export async function coreGitStage(hostId: string, sessionId: string, path: string): Promise<void> {
  await invoke('core_git_stage', { hostId, sessionId, path });
}

export async function coreGitUnstage(
  hostId: string,
  sessionId: string,
  path: string,
): Promise<void> {
  await invoke('core_git_unstage', { hostId, sessionId, path });
}

export async function coreGitDiscard(
  hostId: string,
  sessionId: string,
  path: string,
): Promise<void> {
  await invoke('core_git_discard', { hostId, sessionId, path });
}

export async function coreGitStageHunk(
  hostId: string,
  sessionId: string,
  path: string,
  hunkIndex: number,
): Promise<void> {
  await invoke('core_git_stage_hunk', { hostId, sessionId, path, hunkIndex });
}

export async function coreGitUnstageHunk(
  hostId: string,
  sessionId: string,
  path: string,
  hunkIndex: number,
): Promise<void> {
  await invoke('core_git_unstage_hunk', { hostId, sessionId, path, hunkIndex });
}

export async function coreGitStageAll(hostId: string, sessionId: string): Promise<void> {
  await invoke('core_git_stage_all', { hostId, sessionId });
}

export async function coreGitUnstageAll(hostId: string, sessionId: string): Promise<void> {
  await invoke('core_git_unstage_all', { hostId, sessionId });
}

export async function coreGitDiscardAll(hostId: string, sessionId: string): Promise<void> {
  await invoke('core_git_discard_all', { hostId, sessionId });
}

export async function coreGitCommit(
  hostId: string,
  sessionId: string,
  message: string,
  amend = false,
): Promise<void> {
  await invoke('core_git_commit', { hostId, sessionId, message, amend });
}

export async function coreGitUndoCommit(hostId: string, sessionId: string): Promise<void> {
  await invoke('core_git_undo_commit', { hostId, sessionId });
}

export async function coreGitPush(hostId: string, sessionId: string): Promise<void> {
  await invoke('core_git_push', { hostId, sessionId });
}

export async function coreDiffParse(diff: string): Promise<ParsedDiffView> {
  return invoke('core_diff_parse', { diff });
}

export function groupSummary(summary: DiffSummary): {
  staged: DiffFileStat[];
  unstaged: DiffFileStat[];
  untracked: DiffFileStat[];
} {
  const staged: DiffFileStat[] = [];
  const unstaged: DiffFileStat[] = [];
  const untracked: DiffFileStat[] = [];
  for (const file of summary.files) {
    if (file.staged === true) staged.push(file);
    else if (file.untracked === true) untracked.push(file);
    else unstaged.push(file);
  }
  return { staged, unstaged, untracked };
}

export function isImagePath(path: string): boolean {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(extension);
}

export function canRewriteHead(status: RepoStatus): boolean {
  if (!status.shortSha && !status.branch) return false;
  return status.upstream === null || status.ahead >= 1;
}

export function canPushHead(status: RepoStatus): boolean {
  if (!status.shortSha && !status.branch) return false;
  if (status.detached) return false;
  return status.upstream === null || status.ahead > 0;
}

export function formatRepoStatusLabel(status: RepoStatus): string | null {
  if (!status.branch && !status.shortSha) return null;
  if (status.detached) return `detached @ ${status.shortSha || 'unknown'}`;
  const name = status.branch || 'HEAD';
  const parts = [name];
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.join(' ');
}

export function canCommit(stagedCount: number, message: string, committing: boolean): boolean {
  return stagedCount > 0 && message.trim().length > 0 && !committing;
}

export function bytesToDataUrl(bytes: DiffFileBytes): string {
  return `data:${bytes.contentType};base64,${bytes.base64}`;
}

import { spawnSync } from 'node:child_process';

export interface RepoStatus {
  branch: string;
  shortSha: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export const EMPTY_REPO_STATUS: RepoStatus = {
  branch: '',
  shortSha: '',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
};

/** True when rewriting HEAD (amend / soft-undo) is safe: no upstream, or local tip is ahead. */
export function canRewriteHead(status: RepoStatus): boolean {
  if (!status.shortSha && !status.branch) return false;
  return status.upstream === null || status.ahead >= 1;
}

export function formatRepoStatusLabel(status: RepoStatus): string | null {
  if (!status.branch && !status.shortSha) return null;
  if (status.detached) {
    return `detached @ ${status.shortSha || 'unknown'}`;
  }
  const name = status.branch || 'HEAD';
  const parts = [name];
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.join(' ');
}

function gitOut(root: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: (result.stdout || '').trim() };
}

export function readRepoStatus(root: string): RepoStatus {
  const shortSha = gitOut(root, ['rev-parse', '--short', 'HEAD']).stdout;
  const abbrev = gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const detached = abbrev.stdout === 'HEAD';
  const branch = detached ? '' : abbrev.stdout;

  const upstreamResult = gitOut(root, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  const upstream =
    upstreamResult.status === 0 && upstreamResult.stdout ? upstreamResult.stdout : null;

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = gitOut(root, ['rev-list', '--left-right', '--count', `HEAD...@{upstream}`]);
    if (counts.status === 0) {
      const [left, right] = counts.stdout.split(/\s+/);
      ahead = Number(left) || 0;
      behind = Number(right) || 0;
    }
  }

  return { branch, shortSha, detached, upstream, ahead, behind };
}

// Client-side model for the server's RepoStatus payload
// (see apps/server/src/server/gitStatus.ts). Pure helpers stay mirrored across
// the mobile/server boundary intentionally — no shared package yet.
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

export function canRewriteHead(status: RepoStatus): boolean {
  if (!status.shortSha && !status.branch) return false;
  return status.upstream === null || status.ahead >= 1;
}

/** Show Push when there is something to send (ahead, or no upstream yet). */
export function canPushHead(status: RepoStatus): boolean {
  if (!status.shortSha && !status.branch) return false;
  if (status.detached) return false;
  return status.upstream === null || status.ahead > 0;
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

export function parseRepoStatus(value: unknown): RepoStatus | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.branch !== 'string' || typeof o.shortSha !== 'string') return null;
  if (typeof o.detached !== 'boolean') return null;
  if (!(o.upstream === null || typeof o.upstream === 'string')) return null;
  if (typeof o.ahead !== 'number' || typeof o.behind !== 'number') return null;
  return {
    branch: o.branch,
    shortSha: o.shortSha,
    detached: o.detached,
    upstream: o.upstream,
    ahead: o.ahead,
    behind: o.behind,
  };
}

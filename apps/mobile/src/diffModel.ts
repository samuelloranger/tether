export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
}

export interface DiffSummary {
  files: DiffFileStat[];
}

export type DiffLineKind = 'add' | 'remove' | 'meta' | 'context';

export function totalChanges(summary: DiffSummary): number {
  return summary.files.reduce((sum, f) => sum + f.insertions + f.deletions, 0);
}

export function changeLabel(summary: DiffSummary): string | null {
  if (totalChanges(summary) === 0) return null;
  const insertions = summary.files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = summary.files.reduce((sum, file) => sum + file.deletions, 0);
  return `+${insertions} -${deletions}`;
}

export function changeBannerLabel(summary: DiffSummary): string | null {
  const label = changeLabel(summary);
  return label ? `View changes, ${label}` : null;
}

export function diffLineKind(line: string): DiffLineKind {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('@@')
  )
    return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

export function diffLineKinds(diff: string): DiffLineKind[] {
  return diff.split('\n').map(diffLineKind);
}

export function displayDiff(diff: string, truncated: boolean): string {
  return truncated ? `${diff}\n[Diff truncated at 1 MiB]` : diff;
}

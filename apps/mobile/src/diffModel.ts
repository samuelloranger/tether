export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
}

export interface DiffSummary {
  files: DiffFileStat[];
}

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

export function displayDiff(diff: string, truncated: boolean): string {
  return truncated ? `${diff}\n[Diff truncated at 1 MiB]` : diff;
}

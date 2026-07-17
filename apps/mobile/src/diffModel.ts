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

export function displayDiff(diff: string, truncated: boolean): string {
  return truncated ? `${diff}\n[Diff truncated at 1 MiB]` : diff;
}

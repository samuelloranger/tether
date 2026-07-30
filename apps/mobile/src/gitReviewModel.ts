import { type DiffFileStat, type DiffSummary, groupSummary } from './diffModel';

export type ReviewFileEntry = {
  path: string;
  mode: 'staged' | 'unstaged';
  file: DiffFileStat;
};

export function reviewFileEntries(summary: DiffSummary): ReviewFileEntry[] {
  const { staged, unstaged } = groupSummary(summary);
  return [
    ...staged.map((file) => ({ path: file.path, mode: 'staged' as const, file })),
    ...unstaged.map((file) => ({ path: file.path, mode: 'unstaged' as const, file })),
  ];
}

export function reviewDiffKey(mode: 'staged' | 'unstaged', path: string): string {
  return `${mode}:${path}`;
}

export function toggleSetMember(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function canCommit(stagedCount: number, message: string, committing: boolean): boolean {
  return stagedCount > 0 && message.trim().length > 0 && !committing;
}

/** Stable fingerprint of a summary for effect deps / change detection. */
export function summaryFingerprint(summary: DiffSummary): string {
  return summary.files
    .map(
      (f) =>
        `${f.staged === true ? 'S' : 'U'}:${f.path}:${f.insertions}:${f.deletions}:${f.binary ? 1 : 0}`,
    )
    .join('|');
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

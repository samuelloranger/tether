import type { DiffSummary } from './gitApi';
import { groupSummary } from './gitApi';

export type ReviewFileEntry = {
  path: string;
  mode: 'staged' | 'unstaged';
  file: DiffSummary['files'][number];
};

export function reviewFileEntries(summary: DiffSummary): ReviewFileEntry[] {
  const { staged, unstaged, untracked } = groupSummary(summary);
  return [
    ...staged.map((file) => ({ path: file.path, mode: 'staged' as const, file })),
    ...unstaged.map((file) => ({ path: file.path, mode: 'unstaged' as const, file })),
    ...untracked.map((file) => ({ path: file.path, mode: 'unstaged' as const, file })),
  ];
}

export function reviewDiffKey(mode: 'staged' | 'unstaged', path: string): string {
  return `${mode}:${path}`;
}

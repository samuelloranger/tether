export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffSummary {
  files: DiffFileStat[];
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

export function isImagePath(path: string): boolean {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return IMAGE_EXTENSIONS.has(extension);
}

export type FileTreeNode =
  | { type: 'dir'; name: string; path: string; children: FileTreeNode[] }
  | { type: 'file'; name: string; path: string; file: DiffFileStat };

// Builds a real nested folder tree from flat file paths (like a file
// explorer), instead of grouping by immediate parent directory only —
// src/nested/deep.ts gets a "src" folder containing a "nested" folder
// containing the file, rather than its own flat "src/nested" group.
export function buildFileTree(files: DiffFileStat[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const dirIndex = new Map<string, FileTreeNode & { type: 'dir' }>();
  for (const file of files) {
    const segments = file.path.split('/');
    let siblings = root;
    let currentPath = '';
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${segments[i]}` : segments[i];
      let dir = dirIndex.get(currentPath);
      if (!dir) {
        dir = { type: 'dir', name: segments[i], path: currentPath, children: [] };
        dirIndex.set(currentPath, dir);
        siblings.push(dir);
      }
      siblings = dir.children;
    }
    siblings.push({ type: 'file', name: segments[segments.length - 1], path: file.path, file });
  }
  return root;
}

export type DiffLineKind = 'add' | 'remove' | 'meta' | 'context';

export function totalChanges(summary: DiffSummary): number {
  return summary.files.reduce((sum, f) => sum + f.insertions + f.deletions, 0);
}

export function changeLabel(summary: DiffSummary): string | null {
  if (summary.files.length === 0) return null;
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

export interface DiffLine {
  text: string;
  kind: DiffLineKind;
  // Content with the leading unified-diff marker (+/-/space) stripped, for
  // feeding to a syntax highlighter without corrupting its tokenization.
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Walks a unified diff assigning old/new line numbers per hunk, so the UI can
// render a gutter like a normal code diff viewer instead of raw +/- markup.
export function parseDiffLines(diff: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return diff.split('\n').map((text) => {
    const kind = diffLineKind(text);
    const hunk = kind === 'meta' ? text.match(HUNK_HEADER) : null;
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text, kind, content: text, oldLine: null, newLine: null };
    }
    if (kind === 'meta') return { text, kind, content: text, oldLine: null, newLine: null };
    const content = text.slice(1);
    if (kind === 'remove') return { text, kind, content, oldLine: oldLine++, newLine: null };
    if (kind === 'add') return { text, kind, content, oldLine: null, newLine: newLine++ };
    return { text, kind, content, oldLine: oldLine++, newLine: newLine++ };
  });
}

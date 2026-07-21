export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  // Index (staged) vs working-tree (unstaged) side; absent on older servers.
  staged?: boolean;
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

// --- Diff view v2: staged grouping, hunk actions, side-by-side ---

export interface SummaryGroups {
  staged: DiffFileStat[];
  unstaged: DiffFileStat[];
}

// Splits the summary the way `git status` does. Servers before the staged
// split omit the flag — those entries read as unstaged, matching the old
// single-list behavior.
export function groupSummary(summary: DiffSummary): SummaryGroups {
  const staged = summary.files.filter((f) => f.staged === true);
  const unstaged = summary.files.filter((f) => f.staged !== true);
  return { staged, unstaged };
}

const HUNK_START = /^@@ -\d/;

// Ordinal hunk index for each parsed diff line (null for non-header lines).
// The index is what the stage-hunk/unstage-hunk endpoints consume — it must
// count hunks exactly the way the server's splitHunks does: one per @@ header.
export function annotateHunkIndices(lines: DiffLine[]): (number | null)[] {
  let hunk = -1;
  return lines.map((line) => {
    if (line.kind === 'meta' && HUNK_START.test(line.text)) {
      hunk++;
      return hunk;
    }
    return null;
  });
}

export interface SideBySideRow {
  left: DiffLine | null;
  right: DiffLine | null;
  // Meta rows (file headers, hunk headers) span the full width.
  span: boolean;
}

// Pairs a unified diff's remove/add runs into aligned two-column rows: within
// each change block the i-th removed line sits opposite the i-th added line,
// leftovers get a blank opposite cell, and context/meta lines occupy both
// sides. Feeds the desktop/tablet split view.
export function pairDiffRows(lines: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let removes: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(removes.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({ left: removes[i] ?? null, right: adds[i] ?? null, span: false });
    }
    removes = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === 'remove') {
      removes.push(line);
    } else if (line.kind === 'add') {
      adds.push(line);
    } else {
      flush();
      if (line.kind === 'meta') rows.push({ left: line, right: null, span: true });
      else rows.push({ left: line, right: line, span: false });
    }
  }
  flush();
  return rows;
}

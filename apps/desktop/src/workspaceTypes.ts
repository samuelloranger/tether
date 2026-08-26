export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function lineOffset(content: string, line?: number): number {
  return Math.max(0, Math.min(content.split('\n').length - 1, (line ?? 1) - 1));
}

export interface FileView {
  path: string;
  content: string;
  line?: number;
  column?: number;
}

export interface Presentation {
  id: string;
  title: string;
  project: string;
  revision: number;
  url: string;
  sessionId?: string;
}

export interface FileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  staged?: boolean;
}

/** Browse-mode extras on a directory row (lazy workspace listing). Absent for sync trees. */
export type FileTreeDirBrowse = {
  /** Children have been fetched (may be empty). */
  loaded: boolean;
  loading?: boolean;
  error?: string;
  truncated?: boolean;
};

export type FileTreeNode =
  | {
      type: 'dir';
      name: string;
      path: string;
      children: FileTreeNode[];
      browse?: FileTreeDirBrowse;
    }
  | { type: 'file'; name: string; path: string; file: FileStat };

export function previewUrl(baseUrl: string, relative: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return relative.startsWith('/') ? `${base}${relative}` : `${base}/${relative}`;
}

export function findSessionPreview(
  presentations: Presentation[],
  sessionId: string,
): Presentation | null {
  let match: Presentation | null = null;
  for (const preview of presentations) {
    if (preview.sessionId === sessionId) match = preview;
  }
  return match;
}

export function pickAutoSelectPreview(
  rows: Presentation[],
  seen: ReadonlySet<string>,
  activeId: string,
): Presentation | null {
  return rows.find((preview) => !seen.has(preview.id) && preview.sessionId === activeId) ?? null;
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  html: 'markup',
  css: 'css',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
};

export function languageForPath(path: string): string | null {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return LANGUAGES[extension] ?? null;
}

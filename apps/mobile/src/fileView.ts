export interface FileView {
  path: string;
  content: string;
  line?: number;
  column?: number;
}

export function lineOffset(content: string, line?: number): number {
  return Math.max(0, Math.min(content.split('\n').length - 1, (line ?? 1) - 1));
}

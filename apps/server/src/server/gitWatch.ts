import { type FSWatcher, watch } from 'node:fs';
import { type DiffSummary, EMPTY_DIFF_SUMMARY, GitDiffError, readDiffSummary } from './gitDiff';
import { resolveGitDir } from './gitRoot';

export class GitWatch {
  private root: string | null | undefined;
  private handles: FSWatcher[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private lastSummary: DiffSummary | null = null;
  private disposed = false;

  constructor(
    private readonly onChange: (summary: DiffSummary) => void,
    private readonly debounceMs = 150,
  ) {}

  setRoot(root: string | null) {
    if (this.disposed || root === this.root) return;
    this.closeHandles();
    this.root = root;
    this.lastSummary = null;

    if (root) {
      try {
        this.handles.push(
          watch(root, { recursive: true }, this.schedule),
          watch(resolveGitDir(root), { recursive: true }, this.schedule),
        );
      } catch {
        this.closeHandles();
      }
    }
    this.refresh();
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.closeHandles();
  }

  private schedule = () => {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.refresh, this.debounceMs);
  };

  private refresh = () => {
    this.timer = undefined;
    if (this.disposed) return;
    let summary = EMPTY_DIFF_SUMMARY;
    if (this.root) {
      try {
        summary = readDiffSummary(this.root);
      } catch (error) {
        if (!(error instanceof GitDiffError)) return;
      }
    }
    if (JSON.stringify(summary.files) === JSON.stringify(this.lastSummary?.files)) return;
    this.lastSummary = summary;
    this.onChange(summary);
  };

  private closeHandles() {
    for (const handle of this.handles) handle.close();
    this.handles = [];
  }
}

import { useEffect, useState } from 'react';
import { CommitBox } from './CommitBox';
import { DiffLines } from './DiffLines';
import { coreDiffParse, coreGitDiff, type DiffFileStat, type ParsedDiffView } from './gitApi';
import { reviewDiffKey, reviewFileEntries } from './gitReviewHelpers';
import { useGitCommitForm } from './useGitCommitForm';
import type { GitPanelState } from './useGitPanel';

type Slot =
  | { status: 'loading' }
  | { status: 'ready'; parsed: ParsedDiffView; truncated: boolean }
  | { status: 'error'; message: string };

/**
 * Multi-file review surface (mobile GitReview IA): staged then unstaged file
 * blocks with per-file diffs, hunk actions, and the commit box.
 */
export function GitReview({
  panel,
  hostId,
  sessionId,
  onClose,
}: {
  panel: GitPanelState;
  hostId: string;
  sessionId: string;
  onClose: () => void;
}) {
  const form = useGitCommitForm(panel.commit, panel.amend);
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const [sideBySide, setSideBySide] = useState(false);
  const entries = reviewFileEntries(panel.summary);

  useEffect(() => {
    let cancelled = false;
    const current = reviewFileEntries(panel.summary);
    const next: Record<string, Slot> = {};
    for (const entry of current)
      next[reviewDiffKey(entry.mode, entry.path)] = { status: 'loading' };
    setSlots(next);
    void (async () => {
      for (const entry of current) {
        const key = reviewDiffKey(entry.mode, entry.path);
        try {
          const payload = await coreGitDiff(hostId, sessionId, entry.path, entry.mode);
          const parsed = await coreDiffParse(payload.diff);
          if (cancelled) return;
          setSlots((prev) => ({
            ...prev,
            [key]: { status: 'ready', parsed, truncated: payload.truncated },
          }));
        } catch (error) {
          if (cancelled) return;
          setSlots((prev) => ({
            ...prev,
            [key]: {
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hostId, sessionId, panel.summary]);

  return (
    <aside className="git-review" aria-label="Git review">
      <header className="git-drawer-header">
        <strong>Review changes</strong>
        <div className="git-drawer-header-actions">
          <button
            type="button"
            className="secondary small"
            onClick={() => setSideBySide((value) => !value)}
          >
            {sideBySide ? 'Unified' : 'Side by side'}
          </button>
          <button type="button" className="secondary small" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      <CommitBox
        message={form.commitMessage}
        onChangeMessage={form.setCommitMessage}
        onCommit={() => void form.submitCommit()}
        onAmend={() => void form.submitAmend()}
        onUndoCommit={panel.undoCommit}
        onPush={panel.push}
        canAmend={panel.canAmend}
        canPush={panel.canPush}
        stagedCount={panel.groups.staged.length}
        committing={form.committing}
      />
      <div className="git-review-scroll">
        {entries.length === 0 ? (
          <p className="muted git-pane-message">No uncommitted changes</p>
        ) : (
          entries.map((entry) => (
            <ReviewFileBlock
              key={reviewDiffKey(entry.mode, entry.path)}
              entry={entry}
              slot={slots[reviewDiffKey(entry.mode, entry.path)]}
              sideBySide={sideBySide}
              onToggleHunk={(hunkIndex) =>
                void panel.toggleHunk(entry.path, hunkIndex, entry.mode === 'staged')
              }
            />
          ))
        )}
      </div>
    </aside>
  );
}

function ReviewFileBlock({
  entry,
  slot,
  sideBySide,
  onToggleHunk,
}: {
  entry: { path: string; mode: 'staged' | 'unstaged'; file: DiffFileStat };
  slot: Slot | undefined;
  sideBySide: boolean;
  onToggleHunk: (hunkIndex: number) => void;
}) {
  return (
    <section className="git-review-file">
      <header className="git-review-file-header">
        <span className="git-review-mode">{entry.mode}</span>
        <strong>{entry.path}</strong>
        <span className="muted">
          {entry.file.binary ? 'binary' : `+${entry.file.insertions} -${entry.file.deletions}`}
        </span>
      </header>
      {!slot || slot.status === 'loading' ? (
        <p className="muted git-pane-message">Loading…</p>
      ) : slot.status === 'error' ? (
        <p className="error git-pane-message">{slot.message}</p>
      ) : (
        <DiffLines
          parsed={slot.parsed}
          path={entry.path}
          sideBySide={sideBySide}
          hunkActionLabel={entry.mode === 'staged' ? 'Unstage' : 'Stage'}
          onHunkPress={onToggleHunk}
        />
      )}
    </section>
  );
}

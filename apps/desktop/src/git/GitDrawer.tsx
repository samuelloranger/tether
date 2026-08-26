import { useEffect, useRef, useState } from 'react';
import { CommitBox } from './CommitBox';
import { DiffLines } from './DiffLines';
import { GitTabBar } from './GitSectionHeader';
import { formatRepoStatusLabel } from './gitApi';
import { FileSectionList, HistoryList, ImageDiff } from './gitDrawerPanes';
import { useGitCommitForm } from './useGitCommitForm';
import type { GitPanelState } from './useGitPanel';

const MIN_LEFT = 220;
const MIN_RIGHT = 320;
const SIDE_BY_SIDE_MIN = 900;

type GitDrawerProps = {
  panel: GitPanelState;
  onClose: () => void;
};

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: mirrors mobile GitDrawer pane composition
export function GitDrawer({ panel, onClose }: GitDrawerProps) {
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [leftWidth, setLeftWidth] = useState(320);
  const bodyRef = useRef<HTMLDivElement>(null);
  const form = useGitCommitForm(panel.commit, panel.amend);
  const viewingCommit = tab === 'history' && panel.historyCommit !== null;
  const wideEnough = (bodyRef.current?.clientWidth ?? 1200) - leftWidth >= SIDE_BY_SIDE_MIN;

  useEffect(() => {
    if (tab === 'history' && panel.historyEntries === null) void panel.loadHistory();
  }, [tab, panel]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      const isField =
        target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable;
      if (isField) {
        target.blur();
        return;
      }
      if (panel.historyCommit) {
        void panel.selectCommit(null);
        return;
      }
      if (panel.selectedPath) {
        panel.deselectFile();
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, panel]);

  const title = viewingCommit
    ? `${panel.historyCommit?.entry.shortSha} ${panel.historyCommit?.entry.subject}`
    : (panel.selectedPath ?? 'Working tree');

  const statusLabel = formatRepoStatusLabel(panel.repoStatus);

  const startResize = (clientX: number) => {
    const startX = clientX;
    const startWidth = leftWidth;
    const total = bodyRef.current?.clientWidth ?? 0;
    const onMove = (event: MouseEvent) => {
      const next = Math.round(startWidth + (event.clientX - startX));
      if (total <= MIN_LEFT + MIN_RIGHT) {
        setLeftWidth(Math.floor(total / 2));
        return;
      }
      setLeftWidth(Math.min(Math.max(next, MIN_LEFT), total - MIN_RIGHT));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <aside className="git-drawer" aria-label="Git">
      <header className="git-drawer-header">
        <div className="git-drawer-title-row">
          <strong>{title}</strong>
          {statusLabel ? <span className="muted">{statusLabel}</span> : null}
        </div>
        <div className="git-drawer-header-actions">
          {panel.selectedPath || viewingCommit ? (
            <button
              type="button"
              className="secondary small"
              onClick={() => {
                if (viewingCommit) void panel.selectCommit(null);
                else panel.deselectFile();
              }}
            >
              Back
            </button>
          ) : null}
          <button
            type="button"
            className="secondary small"
            disabled={!wideEnough && !panel.sideBySide}
            onClick={() => panel.setSideBySide(!panel.sideBySide)}
          >
            {panel.sideBySide ? 'Unified' : 'Side by side'}
          </button>
          <button type="button" className="secondary small" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      <GitTabBar
        tab={tab}
        onChange={(next) => {
          setTab(next);
          if (next === 'changes') void panel.selectCommit(null);
        }}
      />
      {panel.error ? <p className="error git-pane-message">{panel.error}</p> : null}
      <div className="git-drawer-body" ref={bodyRef}>
        <div className="git-drawer-left" style={{ width: leftWidth }}>
          {tab === 'history' ? (
            <HistoryList
              entries={panel.historyEntries}
              onSelect={(entry) => void panel.selectCommit(entry)}
            />
          ) : panel.summary.files.length === 0 ? (
            <p className="muted git-pane-message">No uncommitted changes</p>
          ) : (
            <>
              <div className="git-drawer-file-scroll">
                <FileSectionList
                  label="Staged"
                  files={panel.groups.staged}
                  mode="staged"
                  onSelect={panel.selectFile}
                  primaryLabel="Unstage"
                  onPrimary={(path) => void panel.unstageFile(path)}
                  sectionPrimary={{
                    label: 'Unstage all',
                    onClick: () => void panel.unstageAll(),
                  }}
                />
                <FileSectionList
                  label="Unstaged"
                  files={panel.groups.unstaged}
                  mode="unstaged"
                  onSelect={panel.selectFile}
                  primaryLabel="Stage"
                  onPrimary={(path) => void panel.stageFile(path)}
                  secondaryLabel="Discard"
                  onSecondary={(path) => void panel.discardFile(path)}
                  dangerSecondary
                  sectionPrimary={{ label: 'Stage all', onClick: () => void panel.stageAll() }}
                  sectionSecondary={{
                    label: 'Discard all',
                    onClick: () => void panel.discardAll(),
                    danger: true,
                  }}
                />
                <FileSectionList
                  label="Untracked"
                  files={panel.groups.untracked}
                  mode="unstaged"
                  onSelect={panel.selectFile}
                  primaryLabel="Stage"
                  onPrimary={(path) => void panel.stageFile(path)}
                  secondaryLabel="Discard"
                  onSecondary={(path) => void panel.discardFile(path)}
                  dangerSecondary
                />
              </div>
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
            </>
          )}
        </div>
        <button
          type="button"
          className="git-drawer-splitter"
          aria-label="Resize panes"
          onMouseDown={(event) => startResize(event.clientX)}
        />
        <div className="git-drawer-right">
          {panel.diffLoading ? (
            <p className="muted git-pane-message">Loading diff…</p>
          ) : viewingCommit && panel.historyCommit ? (
            <DiffLines
              parsed={panel.historyCommit.parsed}
              path={panel.historyCommit.entry.subject}
              emptyLabel="Empty commit diff"
              sideBySide={panel.sideBySide && wideEnough}
            />
          ) : panel.diffImage ? (
            <ImageDiff oldUrl={panel.diffImage.old} newUrl={panel.diffImage.new} />
          ) : panel.selectedPath && panel.diffMode ? (
            <DiffLines
              parsed={panel.diffParsed}
              path={panel.selectedPath}
              emptyLabel="No changes in this file"
              sideBySide={panel.sideBySide && wideEnough}
              hunkActionLabel={panel.diffMode === 'staged' ? 'Unstage' : 'Stage'}
              onHunkPress={(hunkIndex) => {
                const path = panel.selectedPath;
                const mode = panel.diffMode;
                if (!path || !mode) return;
                void panel.toggleHunk(path, hunkIndex, mode === 'staged');
              }}
            />
          ) : panel.selectedPath ? (
            <DiffLines
              parsed={panel.diffParsed}
              path={panel.selectedPath}
              emptyLabel="No changes in this file"
              sideBySide={panel.sideBySide && wideEnough}
            />
          ) : (
            <p className="muted git-pane-message">Select a file to review</p>
          )}
          {panel.diffTruncated ? (
            <p className="muted git-pane-message">Diff truncated at 1 MiB</p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

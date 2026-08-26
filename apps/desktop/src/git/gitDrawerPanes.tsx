import { splitPath } from './filePath';
import { GitSectionHeader } from './GitSectionHeader';
import type { DiffFileStat, GitLogEntry } from './gitApi';

function FileRow({
  file,
  mode,
  onSelect,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  danger,
}: {
  file: DiffFileStat;
  mode: 'staged' | 'unstaged';
  onSelect: (path: string, mode: 'staged' | 'unstaged') => void;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  danger?: boolean;
}) {
  const { dir, base } = splitPath(file.path);
  return (
    <div className="git-file-row">
      <button
        type="button"
        className="git-file-main"
        onClick={() => onSelect(file.path, mode)}
        title={file.path}
      >
        <span className="git-file-name">
          {dir ? <span className="git-file-dir">{dir}</span> : null}
          <span className="git-file-base">{base}</span>
        </span>
        <span className="git-file-stats muted">
          {file.binary ? 'binary' : `+${file.insertions} -${file.deletions}`}
        </span>
      </button>
      <button type="button" className="linkish small" onClick={onPrimary}>
        {primaryLabel}
      </button>
      {secondaryLabel && onSecondary ? (
        <button
          type="button"
          className={`linkish small${danger ? ' danger' : ''}`}
          onClick={onSecondary}
        >
          {secondaryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function FileSectionList({
  label,
  files,
  mode,
  onSelect,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  sectionPrimary,
  sectionSecondary,
  dangerSecondary,
}: {
  label: string;
  files: DiffFileStat[];
  mode: 'staged' | 'unstaged';
  onSelect: (path: string, mode: 'staged' | 'unstaged') => void;
  primaryLabel: string;
  onPrimary: (path: string) => void;
  secondaryLabel?: string;
  onSecondary?: (path: string) => void;
  sectionPrimary?: { label: string; onClick: () => void };
  sectionSecondary?: { label: string; onClick: () => void; danger?: boolean };
  dangerSecondary?: boolean;
}) {
  if (files.length === 0) return null;
  return (
    <section>
      <GitSectionHeader
        label={label}
        count={files.length}
        actions={
          <>
            {sectionPrimary ? (
              <button type="button" className="linkish small" onClick={sectionPrimary.onClick}>
                {sectionPrimary.label}
              </button>
            ) : null}
            {sectionSecondary ? (
              <button
                type="button"
                className={`linkish small${sectionSecondary.danger ? ' danger' : ''}`}
                onClick={sectionSecondary.onClick}
              >
                {sectionSecondary.label}
              </button>
            ) : null}
          </>
        }
      />
      {files.map((file) => (
        <FileRow
          key={`${mode}:${file.path}`}
          file={file}
          mode={mode}
          onSelect={onSelect}
          primaryLabel={primaryLabel}
          onPrimary={() => onPrimary(file.path)}
          secondaryLabel={secondaryLabel}
          onSecondary={onSecondary ? () => onSecondary(file.path) : undefined}
          danger={dangerSecondary}
        />
      ))}
    </section>
  );
}

export function HistoryList({
  entries,
  onSelect,
}: {
  entries: GitLogEntry[] | null;
  onSelect: (entry: GitLogEntry) => void;
}) {
  if (entries === null) {
    return <p className="muted git-pane-message">Loading history…</p>;
  }
  if (entries.length === 0) {
    return <p className="muted git-pane-message">No commits yet</p>;
  }
  return (
    <ul className="git-history-list">
      {entries.map((entry) => (
        <li key={entry.sha}>
          <button type="button" className="git-history-row" onClick={() => onSelect(entry)}>
            <span className="git-history-sha">{entry.shortSha}</span>
            <span className="git-history-subject">{entry.subject}</span>
            <span className="muted git-history-meta">
              {entry.author} · {entry.date.slice(0, 10)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ImageDiff({ oldUrl, newUrl }: { oldUrl: string | null; newUrl: string | null }) {
  return (
    <div className="git-image-diff">
      <div>
        <div className="muted">Old</div>
        {oldUrl ? <img src={oldUrl} alt="Old version" /> : <span className="muted">None</span>}
      </div>
      <div>
        <div className="muted">New</div>
        {newUrl ? <img src={newUrl} alt="New version" /> : <span className="muted">None</span>}
      </div>
    </div>
  );
}

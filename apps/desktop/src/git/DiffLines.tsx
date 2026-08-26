import { highlightLine, languageForPath } from './codeHighlight';
import type { DiffLine, ParsedDiffView } from './gitApi';

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;

type DiffLinesProps = {
  parsed: ParsedDiffView | null;
  path: string;
  emptyLabel?: string;
  /** When set, replaces emptyLabel — a failed load must not read as empty. */
  error?: string | null;
  onRetry?: () => void;
  onHunkPress?: (hunkIndex: number) => void;
  hunkActionLabel?: string;
  sideBySide?: boolean;
};

function LineTokens({ content, path }: { content: string; path: string }) {
  const tokens = highlightLine(content, languageForPath(path));
  return (
    <>
      {tokens.map((token, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: token stream has no stable id
        <span key={index} className={token.className}>
          {token.text}
        </span>
      ))}
    </>
  );
}

function DiffContentRow({
  line,
  path,
  numberWidth,
}: {
  line: DiffLine;
  path: string;
  numberWidth: number;
}) {
  return (
    <div className={`git-diff-row git-diff-${line.kind}`}>
      <span className="git-diff-gutter" style={{ width: numberWidth }}>
        {line.oldLine ?? ''}
      </span>
      <span className="git-diff-gutter" style={{ width: numberWidth }}>
        {line.newLine ?? ''}
      </span>
      <span className="git-diff-marker">
        {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
      </span>
      <span className="git-diff-code">
        <LineTokens content={line.content} path={path} />
      </span>
    </div>
  );
}

function SideCell({
  line,
  path,
  side,
}: {
  line: DiffLine | null;
  path: string;
  side: 'left' | 'right';
}) {
  if (!line) return <div className="git-sbs-cell git-sbs-empty" />;
  const lineNumber = side === 'left' ? line.oldLine : line.newLine;
  return (
    <div className={`git-sbs-cell git-diff-${line.kind}`}>
      <span className="git-diff-gutter">{lineNumber ?? ''}</span>
      <span className="git-diff-code">
        <LineTokens content={line.content} path={path} />
      </span>
    </div>
  );
}

export function DiffLines({
  parsed,
  path,
  emptyLabel = 'No changes in this file',
  error,
  onRetry,
  onHunkPress,
  hunkActionLabel,
  sideBySide = false,
}: DiffLinesProps) {
  if (error) {
    return (
      <div className="git-diff-empty">
        <p className="error">{error}</p>
        {onRetry ? (
          <button type="button" className="linkish" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (!parsed || parsed.lines.length === 0) {
    return <div className="git-diff-empty muted">{emptyLabel}</div>;
  }

  if (sideBySide) {
    return (
      <div className="git-diff-scroll">
        <div className="git-diff-body git-sbs-body">
          {parsed.rows.map((row, index) => {
            if (row.span && row.left) {
              const leftText = row.left.text;
              const hunkContext = leftText.match(HUNK_HEADER)?.[1] ?? '';
              const lineIndex = parsed.lines.findIndex(
                (line) => line.kind === 'meta' && line.text === leftText,
              );
              const hunkIndex = lineIndex >= 0 ? parsed.hunkIndices[lineIndex] : null;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff rows lack stable ids
                <div key={index} className="git-diff-hunk git-sbs-span">
                  <span className="muted">⋯ {hunkContext}</span>
                  {onHunkPress && hunkIndex != null ? (
                    <button
                      type="button"
                      className="linkish small"
                      onClick={() => onHunkPress(hunkIndex)}
                    >
                      {hunkActionLabel ?? 'Stage'}
                    </button>
                  ) : null}
                </div>
              );
            }
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff rows lack stable ids
              <div key={index} className="git-sbs-row">
                <SideCell line={row.left} path={path} side="left" />
                <SideCell line={row.right} path={path} side="right" />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const maxLineNumber = parsed.lines.reduce(
    (max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0),
    1,
  );
  const numberWidth = String(maxLineNumber).length * 8 + 8;
  let hunkOrdinal = -1;

  return (
    <div className="git-diff-scroll">
      <div className="git-diff-body">
        {parsed.lines.map((line, index) => {
          const hunkContext = line.kind === 'meta' ? line.text.match(HUNK_HEADER)?.[1] : undefined;
          if (hunkContext !== undefined) {
            hunkOrdinal += 1;
            const hunkIndex = parsed.hunkIndices[index] ?? hunkOrdinal;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines lack stable ids
              <div key={index} className="git-diff-hunk">
                <span className="muted">⋯ {hunkContext}</span>
                {onHunkPress ? (
                  <button
                    type="button"
                    className="linkish small"
                    onClick={() => onHunkPress(hunkIndex)}
                  >
                    {hunkActionLabel ?? 'Stage'}
                  </button>
                ) : null}
              </div>
            );
          }
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines lack stable ids
            <DiffContentRow key={index} line={line} path={path} numberWidth={numberWidth} />
          );
        })}
      </div>
    </div>
  );
}

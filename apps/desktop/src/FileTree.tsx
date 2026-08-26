import type { FileTreeNode } from './workspaceTypes';

export function FileTree({
  nodes,
  depth = 0,
  collapseScope,
  collapsedDirs,
  onToggleDir,
  onSelectFile,
  onRetryDir,
  showDiffStats = false,
}: {
  nodes: FileTreeNode[];
  depth?: number;
  collapseScope?: 'staged' | 'unstaged';
  collapsedDirs: Set<string>;
  onToggleDir: (key: string) => void;
  onSelectFile: (path: string) => void;
  onRetryDir?: (path: string) => void;
  showDiffStats?: boolean;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'dir') {
          const collapseKey = collapseScope ? `${collapseScope}:${node.path}` : node.path;
          const collapsed = collapsedDirs.has(collapseKey);
          const browse = node.browse;
          return (
            <div key={collapseKey} className="file-tree-dir">
              <button
                type="button"
                className="file-tree-dir-row"
                style={{ paddingLeft: depth * 16 }}
                aria-label={`${collapsed ? 'Expand' : 'Collapse'} folder ${node.path}`}
                onClick={() => onToggleDir(collapseKey)}
              >
                <span className="file-tree-chevron">{collapsed ? '▸' : '▾'}</span>
                <span className="file-tree-folder" aria-hidden>
                  /
                </span>
                <span className="file-tree-label muted">{node.name}</span>
              </button>
              {!collapsed && (
                <div className="file-tree-children">
                  {browse?.loading ? (
                    <p className="muted file-tree-status" style={{ paddingLeft: (depth + 1) * 16 }}>
                      Loading…
                    </p>
                  ) : null}
                  {browse?.error ? (
                    <div className="file-tree-status" style={{ paddingLeft: (depth + 1) * 16 }}>
                      <p className="error">{browse.error}</p>
                      {onRetryDir ? (
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => onRetryDir(node.path)}
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {!browse?.loading &&
                  !browse?.error &&
                  browse?.loaded &&
                  node.children.length === 0 ? (
                    <p className="muted file-tree-status" style={{ paddingLeft: (depth + 1) * 16 }}>
                      Empty directory
                    </p>
                  ) : null}
                  {browse?.truncated ? (
                    <p className="muted file-tree-status" style={{ paddingLeft: (depth + 1) * 16 }}>
                      Listing truncated (2000-entry limit)
                    </p>
                  ) : null}
                  <FileTree
                    nodes={node.children}
                    depth={depth + 1}
                    collapseScope={collapseScope}
                    collapsedDirs={collapsedDirs}
                    onToggleDir={onToggleDir}
                    onSelectFile={onSelectFile}
                    onRetryDir={onRetryDir}
                    showDiffStats={showDiffStats}
                  />
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            key={node.path}
            type="button"
            className="file-tree-file-row"
            style={{ paddingLeft: depth * 16 + 20 }}
            aria-label={`Select ${node.path}`}
            onClick={() => onSelectFile(node.path)}
          >
            <span className="file-tree-label">{node.name}</span>
            {showDiffStats &&
              (node.file.binary ? (
                <span className="file-tree-stat muted">binary</span>
              ) : (
                <span className="file-tree-stat">
                  <span className="file-tree-add">+{node.file.insertions}</span>{' '}
                  <span className="file-tree-del">-{node.file.deletions}</span>
                </span>
              ))}
          </button>
        );
      })}
    </>
  );
}

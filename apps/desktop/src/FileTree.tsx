import type { FileTreeNode } from './workspaceTypes';

export function FileTree({
  nodes,
  depth = 0,
  collapseScope,
  collapsedDirs,
  onToggleDir,
  onSelectFile,
  showDiffStats = false,
}: {
  nodes: FileTreeNode[];
  depth?: number;
  collapseScope?: 'staged' | 'unstaged';
  collapsedDirs: Set<string>;
  onToggleDir: (key: string) => void;
  onSelectFile: (path: string) => void;
  showDiffStats?: boolean;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'dir') {
          const collapseKey = collapseScope ? `${collapseScope}:${node.path}` : node.path;
          const collapsed = collapsedDirs.has(collapseKey);
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
                <FileTree
                  nodes={node.children}
                  depth={depth + 1}
                  collapseScope={collapseScope}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={onToggleDir}
                  onSelectFile={onSelectFile}
                  showDiffStats={showDiffStats}
                />
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

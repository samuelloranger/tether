import { useState } from 'react';
import { FileTree } from './FileTree';
import { usePresentations } from './usePresentations';
import { useWorkspaceFiles, useWorkspaceUpload } from './useWorkspaceFiles';

export function useWorkspace({
  hostId,
  sessionId,
  baseUrl,
  enabled,
}: {
  hostId: string | null;
  sessionId: string;
  baseUrl: string | null;
  enabled: boolean;
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const files = useWorkspaceFiles({ hostId, sessionId });
  const upload = useWorkspaceUpload({
    hostId,
    sessionIdRef: files.sessionIdRef,
    enabled,
  });
  const presentations = usePresentations({ hostId, sessionId, baseUrl, enabled });

  const openFile = async (path: string, line?: number, column?: number) => {
    await files.openFile(path, line, column);
    setWorkspaceOpen(false);
  };

  return {
    ...files,
    openFile,
    ...upload,
    ...presentations,
    workspaceOpen,
    setWorkspaceOpen,
  };
}

export type WorkspaceState = ReturnType<typeof useWorkspace>;

export function WorkspacePanel({ workspace }: { workspace: WorkspaceState }) {
  return (
    <aside className="workspace-panel">
      <header className="workspace-panel-header">
        <strong>Workspace</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="Close workspace"
          onClick={() => workspace.setWorkspaceOpen(false)}
        >
          ×
        </button>
      </header>
      <form
        className="workspace-open-form"
        onSubmit={(event) => {
          event.preventDefault();
          const path = workspace.openPath.trim();
          if (path) void workspace.openFile(path);
        }}
      >
        <input
          value={workspace.openPath}
          onChange={(event) => workspace.setOpenPath(event.target.value)}
          placeholder="path/to/file.ts"
          aria-label="Workspace file path"
        />
        <button type="submit" className="small">
          Open
        </button>
      </form>
      <div className="workspace-actions">
        <button
          type="button"
          className="secondary small"
          onClick={() => void workspace.pickAndUpload()}
        >
          Upload file…
        </button>
        <span className="muted workspace-drop-hint">or drop a file on the window</span>
      </div>
      {workspace.fileError && <p className="error">{workspace.fileError}</p>}
      {workspace.uploadError && <p className="error">{workspace.uploadError}</p>}
      <div className="workspace-tree">
        {workspace.tree.length === 0 ? (
          <p className="muted">Opened files appear here.</p>
        ) : (
          <FileTree
            nodes={workspace.tree}
            collapsedDirs={workspace.collapsedDirs}
            onToggleDir={workspace.toggleDir}
            onSelectFile={(path) => void workspace.openFile(path)}
          />
        )}
      </div>
    </aside>
  );
}

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
  const files = useWorkspaceFiles({
    hostId,
    sessionId,
    browseEnabled: workspaceOpen,
  });
  const upload = useWorkspaceUpload({
    hostId,
    sessionIdRef: files.sessionIdRef,
    enabled,
  });
  const presentations = usePresentations({ hostId, sessionId, baseUrl, enabled });

  const openFile = async (path: string, line?: number, column?: number) => {
    const ok = await files.openFile(path, line, column);
    if (ok) setWorkspaceOpen(false);
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

function WorkspaceTreeBody({ workspace }: { workspace: WorkspaceState }) {
  if (workspace.rootError) {
    return (
      <div className="git-pane-message">
        <p className="error">{workspace.rootError}</p>
        <button type="button" className="linkish" onClick={() => workspace.reloadRoot()}>
          Retry
        </button>
      </div>
    );
  }
  if (workspace.rootLoading && workspace.tree.length === 0) {
    return <p className="muted">Loading…</p>;
  }
  if (workspace.rootEmpty) {
    return <p className="muted">Empty directory</p>;
  }
  if (workspace.tree.length === 0) {
    return <p className="muted">No files to show.</p>;
  }
  return (
    <FileTree
      nodes={workspace.tree}
      collapsedDirs={workspace.collapsedDirs}
      onToggleDir={workspace.toggleDir}
      onSelectFile={(path) => void workspace.openFile(path)}
      onRetryDir={(path) => workspace.reloadDir(path)}
    />
  );
}

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
      {workspace.fileError ? (
        <div className="git-pane-message">
          <p className="error">{workspace.fileError}</p>
          {workspace.openPath.trim() ? (
            <button
              type="button"
              className="linkish"
              onClick={() => void workspace.openFile(workspace.openPath.trim())}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {workspace.uploadError ? <p className="error">{workspace.uploadError}</p> : null}
      {workspace.rootTruncated ? (
        <p className="muted">Listing truncated (2000-entry limit)</p>
      ) : null}
      <div className="workspace-tree">
        <WorkspaceTreeBody workspace={workspace} />
      </div>
    </aside>
  );
}

import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestPaste } from './pasteBus';
import { coreFileTreeBuild, coreWorkspaceFile, coreWorkspaceUpload } from './workspaceApi';
import type { FileStat, FileTreeNode, FileView } from './workspaceTypes';
import { shellQuote } from './workspaceTypes';

export function useWorkspaceFiles({
  hostId,
  sessionId,
}: {
  hostId: string | null;
  sessionId: string;
}) {
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState('');
  const [recentFiles, setRecentFiles] = useState<FileStat[]>([]);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    void coreFileTreeBuild(recentFiles)
      .then(setTree)
      .catch(() => setTree([]));
  }, [recentFiles]);

  const rememberPath = useCallback((path: string) => {
    setRecentFiles((prev) => {
      if (prev.some((row) => row.path === path)) return prev;
      return [...prev, { path, insertions: 0, deletions: 0, binary: false }];
    });
  }, []);

  const openFile = useCallback(
    async (path: string, line?: number, column?: number) => {
      if (!hostId) return;
      const openedFor = sessionIdRef.current;
      setFileLoading(true);
      setFileError(null);
      try {
        const file = await coreWorkspaceFile({
          hostId,
          sessionId: openedFor,
          path,
          line,
          column,
        });
        if (sessionIdRef.current === openedFor) {
          setFileView(file);
          rememberPath(file.path);
        }
      } catch (error) {
        setFileError(String(error));
      } finally {
        setFileLoading(false);
      }
    },
    [hostId, rememberPath],
  );

  const closeFile = useCallback(() => {
    setFileView(null);
    setFileError(null);
  }, []);

  const toggleDir = useCallback((key: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return {
    fileView,
    fileLoading,
    fileError,
    openPath,
    setOpenPath,
    openFile,
    closeFile,
    tree,
    collapsedDirs,
    toggleDir,
    sessionIdRef,
  };
}

export function useWorkspaceUpload({
  hostId,
  sessionIdRef,
  enabled,
}: {
  hostId: string | null;
  sessionIdRef: { current: string };
  enabled: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadPaths = useCallback(
    async (paths: string[]) => {
      if (!hostId || paths.length === 0) return;
      setUploading(true);
      setUploadError(null);
      try {
        for (const filePath of paths) {
          const serverPath = await coreWorkspaceUpload({
            hostId,
            sessionId: sessionIdRef.current,
            filePath,
          });
          requestPaste(shellQuote(serverPath));
        }
      } catch (error) {
        setUploadError(String(error));
      } finally {
        setUploading(false);
      }
    },
    [hostId, sessionIdRef],
  );

  const pickAndUpload = useCallback(async () => {
    const selected = await open({ multiple: true, directory: false });
    if (selected === null) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await uploadPaths(paths);
  }, [uploadPaths]);

  // Tauri intercepts OS file drops at the window — DOM drag/drop never fires.
  useEffect(() => {
    if (!enabled || !hostId) return undefined;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        void uploadPaths(event.payload.paths);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled, hostId, uploadPaths]);

  return { uploading, uploadError, setUploadError, pickAndUpload, uploadPaths };
}

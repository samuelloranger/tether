import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestPaste } from './pasteBus';
import { coreWorkspaceDir, coreWorkspaceFile, coreWorkspaceUpload } from './workspaceApi';
import {
  createDirListingCache,
  type DirLoadOk,
  entriesToTreeNodes,
  joinDirPath,
} from './workspaceDirLogic';
import type { FileTreeNode, FileView } from './workspaceTypes';
import { shellQuote } from './workspaceTypes';

function seedCollapsed(
  prev: Set<string>,
  parentPath: string,
  entries: Array<{ name: string; kind: string }>,
): Set<string> {
  let changed = false;
  const next = new Set(prev);
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue;
    const full = joinDirPath(parentPath, entry.name);
    if (!next.has(full)) {
      next.add(full);
      changed = true;
    }
  }
  return changed ? next : prev;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: browse cache + file open share one hook
export function useWorkspaceFiles({
  hostId,
  sessionId,
  browseEnabled = false,
}: {
  hostId: string | null;
  sessionId: string;
  browseEnabled?: boolean;
}) {
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState('');
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [loadedByPath, setLoadedByPath] = useState<Map<string, DirLoadOk>>(() => new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [errorByPath, setErrorByPath] = useState<Map<string, string>>(() => new Map());
  const [rootListingPath, setRootListingPath] = useState('');
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const cacheRef = useRef(
    createDirListingCache((input) =>
      coreWorkspaceDir(input).then((listing) => ({
        path: listing.path,
        entries: listing.entries,
        ...(listing.truncated ? { truncated: true as const } : {}),
      })),
    ),
  );

  const resetBrowse = useCallback(() => {
    cacheRef.current.clear();
    setLoadedByPath(new Map());
    setLoadingPaths(new Set());
    setErrorByPath(new Map());
    setCollapsedDirs(new Set());
    setRootListingPath('');
  }, []);

  // hostId/sessionId intentionally trigger a browse reset when the active target changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the reset trigger
  useEffect(() => {
    resetBrowse();
  }, [hostId, sessionId, resetBrowse]);

  const ensureLoaded = useCallback(
    async (path: string) => {
      if (!hostId) return;
      const openedFor = sessionIdRef.current;
      const cached = cacheRef.current.peek(hostId, openedFor, path);
      if (cached) {
        setLoadedByPath((prev) => {
          if (prev.get(path) === cached) return prev;
          const next = new Map(prev);
          next.set(path, cached);
          return next;
        });
        setErrorByPath((prev) => {
          if (!prev.has(path)) return prev;
          const next = new Map(prev);
          next.delete(path);
          return next;
        });
        return;
      }

      setLoadingPaths((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      setErrorByPath((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Map(prev);
        next.delete(path);
        return next;
      });

      const result = await cacheRef.current.load(hostId, openedFor, path);
      if (sessionIdRef.current !== openedFor) return;

      setLoadingPaths((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });

      if (result.status === 'error') {
        setErrorByPath((prev) => {
          const next = new Map(prev);
          next.set(path, result.message);
          return next;
        });
        return;
      }

      const parentForChildren = path === '' ? result.path : path;
      setLoadedByPath((prev) => {
        const next = new Map(prev);
        next.set(path, result);
        return next;
      });
      setCollapsedDirs((prev) => seedCollapsed(prev, parentForChildren, result.entries));
      if (path === '') setRootListingPath(result.path);
    },
    [hostId],
  );

  // sessionId reloads root after a session switch (ensureLoaded reads sessionIdRef).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reload trigger
  useEffect(() => {
    if (!browseEnabled || !hostId) return;
    void ensureLoaded('');
  }, [browseEnabled, hostId, sessionId, ensureLoaded]);

  const tree = useMemo((): FileTreeNode[] => {
    const root = loadedByPath.get('');
    if (!root) return [];
    return entriesToTreeNodes(
      rootListingPath,
      root.entries,
      loadedByPath,
      loadingPaths,
      errorByPath,
    );
  }, [loadedByPath, loadingPaths, errorByPath, rootListingPath]);

  const rootListing = loadedByPath.get('');
  const rootLoading = loadingPaths.has('');
  const rootError = errorByPath.get('') ?? null;
  const rootTruncated = rootListing?.truncated === true;
  const rootEmpty = !!rootListing && !rootLoading && !rootError && rootListing.entries.length === 0;

  const openFile = useCallback(
    async (path: string, line?: number, column?: number): Promise<boolean> => {
      if (!hostId) return false;
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
        }
        return true;
      } catch (error) {
        setFileError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setFileLoading(false);
      }
    },
    [hostId],
  );

  const closeFile = useCallback(() => {
    setFileView(null);
    setFileError(null);
  }, []);

  const toggleDir = useCallback(
    (key: string) => {
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
          void ensureLoaded(key);
        } else {
          next.add(key);
        }
        return next;
      });
    },
    [ensureLoaded],
  );

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
    rootLoading,
    rootError,
    rootTruncated,
    rootEmpty,
    reloadRoot: () => void ensureLoaded(''),
    reloadDir: (path: string) => void ensureLoaded(path),
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
        setUploadError(error instanceof Error ? error.message : String(error));
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

import type { FileTreeNode } from './workspaceTypes';

export type WorkspaceDirEntry = {
  name: string;
  kind: 'file' | 'dir';
  size: number;
};

export type WorkspaceDirListing = {
  path: string;
  entries: WorkspaceDirEntry[];
  truncated?: true;
};

export type DirFetchInput = {
  hostId: string;
  sessionId: string;
  path: string;
};

export type DirFetch = (input: DirFetchInput) => Promise<WorkspaceDirListing>;

export type DirLoadOk = {
  status: 'ok';
  path: string;
  entries: WorkspaceDirEntry[];
  truncated: boolean;
};

export type DirLoadError = {
  status: 'error';
  message: string;
};

export type DirLoadResult = DirLoadOk | DirLoadError;

export function joinDirPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function dirCacheKey(hostId: string, sessionId: string, path: string): string {
  return `${hostId}\0${sessionId}\0${path}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** In-memory listing cache keyed by (host, session, path). Errors are not retained. */
export function createDirListingCache(fetchDir: DirFetch) {
  const inflight = new Map<string, Promise<DirLoadResult>>();
  const stored = new Map<string, DirLoadOk>();

  async function load(hostId: string, sessionId: string, path: string): Promise<DirLoadResult> {
    const key = dirCacheKey(hostId, sessionId, path);
    const hit = stored.get(key);
    if (hit) return hit;

    const pending = inflight.get(key);
    if (pending) return pending;

    const promise = (async (): Promise<DirLoadResult> => {
      try {
        const listing = await fetchDir({ hostId, sessionId, path });
        const ok: DirLoadOk = {
          status: 'ok',
          path: listing.path,
          entries: listing.entries,
          truncated: listing.truncated === true,
        };
        stored.set(key, ok);
        return ok;
      } catch (error) {
        return { status: 'error', message: errorMessage(error) };
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, promise);
    return promise;
  }

  function clear(): void {
    inflight.clear();
    stored.clear();
  }

  function peek(hostId: string, sessionId: string, path: string): DirLoadOk | undefined {
    return stored.get(dirCacheKey(hostId, sessionId, path));
  }

  return { load, clear, peek };
}

export type DirListingCache = ReturnType<typeof createDirListingCache>;

/** Listing → tree nodes; nested dirs stay pending until their path is loaded. */
export function entriesToTreeNodes(
  parentPath: string,
  entries: WorkspaceDirEntry[],
  loadedChildren: ReadonlyMap<string, DirLoadOk>,
  loadingPaths: ReadonlySet<string>,
  errorByPath: ReadonlyMap<string, string>,
): FileTreeNode[] {
  return entries.map((entry) => {
    const path = joinDirPath(parentPath, entry.name);
    if (entry.kind === 'file') {
      return {
        type: 'file' as const,
        name: entry.name,
        path,
        file: { path, insertions: 0, deletions: 0, binary: false },
      };
    }
    const child = loadedChildren.get(path);
    const error = errorByPath.get(path);
    const loading = loadingPaths.has(path);
    if (child) {
      return {
        type: 'dir' as const,
        name: entry.name,
        path,
        children: entriesToTreeNodes(
          path,
          child.entries,
          loadedChildren,
          loadingPaths,
          errorByPath,
        ),
        browse: {
          loaded: true,
          truncated: child.truncated || undefined,
        },
      };
    }
    return {
      type: 'dir' as const,
      name: entry.name,
      path,
      children: [],
      browse: {
        loaded: false,
        loading: loading || undefined,
        error,
      },
    };
  });
}

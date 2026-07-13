// Desktop self-update via the Tauri updater plugin. Checks the GitHub release
// `latest.json`, verifies the minisign signature against the bundled public key,
// then (driven by the UI) downloads with progress and relaunches. No-op anywhere
// but the Tauri desktop build.

// The updater plugin's Update object — kept opaque; the UI holds it between the
// check and the install.
export type PendingUpdate = {
  update: {
    downloadAndInstall: (cb: (e: DownloadEvent) => void) => Promise<void>;
    // Frees the native (Rust-side) Update resource; call when discarding one.
    close: () => Promise<void>;
  };
  version: string;
  current: string;
};

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

// Check for a newer signed build. Returns null when already current or when this
// install can't self-update (a .deb/.rpm — those update via the package
// manager); throws on a network/feed error (the caller decides whether to surface it).
export async function fetchUpdate(): Promise<PendingUpdate | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  if (!(await invoke<boolean>('is_updatable'))) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return null;
  return {
    update: update as unknown as PendingUpdate['update'],
    version: update.version,
    current: update.currentVersion,
  };
}

// Download + install a pending update, reporting byte progress, then relaunch.
export async function installUpdate(
  pending: PendingUpdate,
  onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
  let total = 0;
  let downloaded = 0;
  await pending.update.downloadAndInstall((e) => {
    if (e.event === 'Started') {
      total = e.data.contentLength ?? 0;
      onProgress(0, total);
    } else if (e.event === 'Progress') {
      downloaded += e.data.chunkLength;
      onProgress(downloaded, total);
    } else if (e.event === 'Finished') {
      onProgress(total, total);
    }
  });
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

// Desktop self-update via the Tauri updater plugin. Checks the GitHub release
// `latest.json`, verifies the minisign signature against the bundled public key,
// then (driven by the UI) downloads with progress and relaunches. No-op anywhere
// but the Tauri desktop build.

// The updater plugin's Update object — kept opaque; the UI holds it between the
// check and the install.
const RELEASES_PAGE = 'https://github.com/samuelloranger/tether/releases/latest';

export type PendingUpdate = {
  update: {
    downloadAndInstall: (cb: (e: DownloadEvent) => void) => Promise<void>;
    // Frees the native (Rust-side) Update resource; call when discarding one.
    close: () => Promise<void>;
  };
  version: string;
  current: string;
  // Whether this install can apply the update in place (macOS/Windows/AppImage).
  // A package-managed install (.deb/.rpm) can't, so the UI offers a download
  // link instead of a self-install button.
  canSelfInstall: boolean;
};

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

// Tauri's webview cannot reliably hand URLs to the Windows shell through
// React Native's browser-oriented Linking API.
export async function openExternalUrl(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

// Check for a newer signed build. Returns null when already current; throws on a
// network/feed error (the caller decides whether to surface it). `canSelfInstall`
// distinguishes installs that can update in place (macOS/Windows/AppImage) from
// package-managed ones (.deb/.rpm) that must download + reinstall.
export async function fetchUpdate(): Promise<PendingUpdate | null> {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const canSelfInstall = await invoke<boolean>('is_updatable');
  return {
    update: update as unknown as PendingUpdate['update'],
    version: update.version,
    current: update.currentVersion,
    canSelfInstall,
  };
}

// Open the releases page in the system browser (for package-managed installs
// that download the new .deb/.rpm and reinstall via their package manager).
export async function openReleasesPage(): Promise<void> {
  await openExternalUrl(RELEASES_PAGE);
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

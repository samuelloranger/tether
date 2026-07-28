import { useEffect, useRef, useState } from 'react';
import { fetchUpdate, installUpdate, openReleasesPage, type PendingUpdate } from '../desktopUpdate';
import { notify } from '../dialog';
import { isDesktop } from '../platform';

export function useDesktopUpdater() {
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    current: string;
    canSelfInstall: boolean;
  } | null>(null);
  const pendingUpdate = useRef<PendingUpdate | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [updating, setUpdating] = useState(false);

  const disposePending = () => {
    pendingUpdate.current?.update.close().catch(() => {});
    pendingUpdate.current = null;
  };

  const showAvailableUpdate = (update: PendingUpdate) => {
    pendingUpdate.current = update;
    setUpdateInfo({
      version: update.version,
      current: update.current,
      canSelfInstall: update.canSelfInstall,
    });
  };

  useEffect(() => {
    if (!isDesktop) return;
    fetchUpdate()
      .then((update) => {
        if (!update) return;
        pendingUpdate.current = update;
        setUpdateInfo({
          version: update.version,
          current: update.current,
          canSelfInstall: update.canSelfInstall,
        });
      })
      .catch(() => {});
    return () => {
      pendingUpdate.current?.update.close().catch(() => {});
      pendingUpdate.current = null;
    };
  }, []);

  const checkForUpdatesManual = async () => {
    try {
      disposePending();
      const update = await fetchUpdate();
      if (update) showAvailableUpdate(update);
      else void notify('Up to date', "You're running the latest version of Tether.");
    } catch {
      void notify('Update check failed', 'Could not reach the update server.', 'error');
    }
  };

  const startUpdate = () => {
    const pending = pendingUpdate.current;
    if (!pending) return;
    setUpdating(true);
    setUpdateProgress({ done: 0, total: 0 });
    installUpdate(pending, (done, total) => setUpdateProgress({ done, total })).catch(() => {
      setUpdating(false);
      setUpdateInfo(null);
      disposePending();
      void notify('Update failed', 'The update could not be downloaded or installed.', 'error');
    });
  };

  const downloadUpdate = () => {
    void openReleasesPage();
    disposePending();
    setUpdateInfo(null);
  };

  const dismissUpdate = () => {
    if (updating) return;
    disposePending();
    setUpdateInfo(null);
    setUpdateProgress(null);
  };

  return {
    updateInfo,
    setUpdateInfo,
    pendingUpdate,
    updateProgress,
    setUpdateProgress,
    updating,
    setUpdating,
    disposePending,
    checkForUpdatesManual,
    startUpdate,
    downloadUpdate,
    dismissUpdate,
  };
}

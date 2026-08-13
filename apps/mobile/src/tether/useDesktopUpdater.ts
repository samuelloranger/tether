import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import { fetchUpdate, installUpdate, openReleasesPage, type PendingUpdate } from '../desktopUpdate';
import { notify } from '../dialog';
import { isDesktop } from '../platform';

type UpdateInfo = { version: string; current: string; canSelfInstall: boolean };
type Progress = { done: number; total: number } | null;
type PendingRef = MutableRefObject<PendingUpdate | null>;

function disposePending(pendingUpdate: PendingRef) {
  pendingUpdate.current?.update.close().catch(() => {});
  pendingUpdate.current = null;
}

function showAvailableUpdate(
  pendingUpdate: PendingRef,
  setUpdateInfo: Dispatch<SetStateAction<UpdateInfo | null>>,
  update: PendingUpdate,
) {
  pendingUpdate.current = update;
  setUpdateInfo({
    version: update.version,
    current: update.current,
    canSelfInstall: update.canSelfInstall,
  });
}

async function checkForUpdatesManual(
  pendingUpdate: PendingRef,
  setUpdateInfo: Dispatch<SetStateAction<UpdateInfo | null>>,
) {
  try {
    disposePending(pendingUpdate);
    const update = await fetchUpdate();
    if (update) showAvailableUpdate(pendingUpdate, setUpdateInfo, update);
    else void notify('Up to date', "You're running the latest version of Tether.");
  } catch {
    void notify('Update check failed', 'Could not reach the update server.', 'error');
  }
}

function startUpdate(
  pendingUpdate: PendingRef,
  setUpdating: Dispatch<SetStateAction<boolean>>,
  setUpdateProgress: Dispatch<SetStateAction<Progress>>,
  setUpdateInfo: Dispatch<SetStateAction<UpdateInfo | null>>,
) {
  const pending = pendingUpdate.current;
  if (!pending) return;
  setUpdating(true);
  setUpdateProgress({ done: 0, total: 0 });
  installUpdate(pending, (done, total) => setUpdateProgress({ done, total })).catch(() => {
    setUpdating(false);
    setUpdateInfo(null);
    disposePending(pendingUpdate);
    void notify('Update failed', 'The update could not be downloaded or installed.', 'error');
  });
}

function downloadUpdate(
  pendingUpdate: PendingRef,
  setUpdateInfo: Dispatch<SetStateAction<UpdateInfo | null>>,
) {
  void openReleasesPage();
  disposePending(pendingUpdate);
  setUpdateInfo(null);
}

function dismissUpdate(
  updating: boolean,
  pendingUpdate: PendingRef,
  setUpdateInfo: Dispatch<SetStateAction<UpdateInfo | null>>,
  setUpdateProgress: Dispatch<SetStateAction<Progress>>,
) {
  if (updating) return;
  disposePending(pendingUpdate);
  setUpdateInfo(null);
  setUpdateProgress(null);
}

export function useDesktopUpdater() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const pendingUpdate = useRef<PendingUpdate | null>(null);
  const [updateProgress, setUpdateProgress] = useState<Progress>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    fetchUpdate()
      .then((update) => {
        if (update) showAvailableUpdate(pendingUpdate, setUpdateInfo, update);
      })
      .catch(() => {});
    return () => disposePending(pendingUpdate);
  }, []);

  return {
    updateInfo,
    setUpdateInfo,
    pendingUpdate,
    updateProgress,
    setUpdateProgress,
    updating,
    setUpdating,
    disposePending: () => disposePending(pendingUpdate),
    checkForUpdatesManual: () => checkForUpdatesManual(pendingUpdate, setUpdateInfo),
    startUpdate: () => startUpdate(pendingUpdate, setUpdating, setUpdateProgress, setUpdateInfo),
    downloadUpdate: () => downloadUpdate(pendingUpdate, setUpdateInfo),
    dismissUpdate: () => dismissUpdate(updating, pendingUpdate, setUpdateInfo, setUpdateProgress),
  };
}

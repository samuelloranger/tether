import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { useAppTheme } from './AppThemeProvider';
import { isDesktop } from './platform';
import { injectTerminalScrollbarStyles } from './terminalScrollbar';
import type { Session } from './tether/context';
import { useFile, useGit, usePresentation, useSession, useUi } from './tether/context';

function useDesktopScrollbarTheme() {
  const { theme } = useAppTheme();
  useEffect(() => {
    if (!isDesktop) return;
    injectTerminalScrollbarStyles({
      thumb: theme.colors.border,
      thumbHover: theme.colors.textMuted,
      track: theme.terminal.bg,
    });
  }, [theme]);
}

function useTerminalBellFlash(activeBellCount: number) {
  const prevBellCount = useRef(0);
  const [bellFlash, setBellFlash] = useState(false);
  useEffect(() => {
    if (activeBellCount > prevBellCount.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setBellFlash(true);
      const t = setTimeout(() => setBellFlash(false), 150);
      prevBellCount.current = activeBellCount;
      return () => clearTimeout(t);
    }
    prevBellCount.current = activeBellCount;
  }, [activeBellCount]);
  return bellFlash;
}

async function dropFiles(event: DragEvent, uploadFile: Session['uploadFile']) {
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  for (const file of Array.from(files)) {
    await uploadFile(file, file.name);
  }
}

function useDesktopFileDrop() {
  const { uploadFile } = useSession();
  const { activePresentation } = usePresentation();
  const { fileView } = useFile();
  const { diffOpen } = useGit();
  useEffect(() => {
    // Takeovers remount #tether-terminal; re-bind so drops keep working.
    void activePresentation;
    void fileView;
    void diffOpen;
    if (!isDesktop) return;
    const el = document.getElementById('tether-terminal');
    if (!el) return;
    const onDragOver = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => void dropFiles(event, uploadFile);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, [uploadFile, activePresentation, fileView, diffOpen]);
}

function useCloseMenusOnTakeover() {
  const { setMenuOpen, setSelectionViewOpen } = useUi();
  const { activePresentation } = usePresentation();
  const { fileView } = useFile();
  const { diffOpen } = useGit();
  useEffect(() => {
    if (activePresentation || fileView || diffOpen) {
      setMenuOpen(false);
      setSelectionViewOpen(false);
    }
  }, [activePresentation, fileView, diffOpen, setMenuOpen, setSelectionViewOpen]);
}

function useHydrateWhenVisible(terminalVisible: boolean, hydrateRenderer: () => void) {
  const hydrateRef = useRef(hydrateRenderer);
  hydrateRef.current = hydrateRenderer;
  useEffect(() => {
    if (terminalVisible) hydrateRef.current();
  }, [terminalVisible]);
}

export function useTerminalScreenEffects(terminalVisible: boolean) {
  const { activeBellCount, hydrateRenderer } = useSession();
  useDesktopScrollbarTheme();
  const bellFlash = useTerminalBellFlash(activeBellCount);
  useDesktopFileDrop();
  useCloseMenusOnTakeover();
  useHydrateWhenVisible(terminalVisible, hydrateRenderer);
  return bellFlash;
}

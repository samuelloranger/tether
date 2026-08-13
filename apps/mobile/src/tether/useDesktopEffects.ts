// biome-ignore-all lint/correctness/useExhaustiveDependencies: event subscriptions intentionally use stable transport refs.
import { useEffect, useRef } from 'react';
import { notify as sendNativeNotification } from '../desktopNotify';
import { injectDragRegionStyles } from '../dragRegion';
import { isDesktop } from '../platform';
import {
  bindDesktopContextMenu,
  bindDesktopKeyboard,
  bindDesktopWindowFocus,
  type DesktopEffectOptions,
} from './desktopEffectBindings';

export type { DesktopEffectOptions };

export function useDesktopEffects(opts: DesktopEffectOptions) {
  const {
    isConfiguring,
    presentations,
    activePresentationId,
    fileViewOpen,
    diffOpen,
    setContextMenu,
    setWindowFocused,
    isWindowFocused,
    refreshSocketActivity,
    activePromptReturnCount,
  } = opts;

  useEffect(() => {
    if (isDesktop) injectDragRegionStyles();
  }, []);

  useEffect(
    () => bindDesktopKeyboard(opts),
    [isConfiguring, activePresentationId, presentations, fileViewOpen, diffOpen],
  );

  useEffect(
    () =>
      bindDesktopContextMenu({
        isConfiguring,
        presentations,
        activePresentationId,
        setContextMenu,
      }),
    [isConfiguring, activePresentationId, presentations],
  );

  useEffect(() => bindDesktopWindowFocus({ setWindowFocused, refreshSocketActivity }), []);

  const previousPromptCount = useRef(0);
  useEffect(() => {
    if (!isDesktop) return;
    const returned = activePromptReturnCount > previousPromptCount.current;
    previousPromptCount.current = activePromptReturnCount;
    if (returned && !isWindowFocused()) void sendNativeNotification('Tether', 'Command finished');
  }, [activePromptReturnCount]);
}

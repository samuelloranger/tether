import { useMemo, useState } from 'react';
import { useMediaScheme, useWideLayout } from '@/platform/useViewport';
import { activeSessionDot, litStateFor, shellVars } from '@/session/litTheme';
import { type AppPreferences, resolveFlavor, sidebarLayout, UI_THEMES } from '@/settings/preferences';
import { useShellChrome } from '@/shell/useHeatArrival';
import type { TetherDesktop } from '@/shell/useTetherDesktop';
import type { WorkspaceState } from '@/workspace/useWorkspace';

export interface UseAppChromeOpts {
  app: TetherDesktop;
  workspace: WorkspaceState;
  prefs: AppPreferences;
}

/** Everything the shell needs to paint itself: theme, layout, tint, and the
 * open/closed state of the drawer, overflow menu and pane picker. */
export function useAppChrome({ app, workspace, prefs }: UseAppChromeOpts) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Which trigger opened the overflow menu, so the panel can hang on that side.
  const [overflowAlign, setOverflowAlign] = useState<'start' | 'end'>('end');
  const [panePickerFor, setPanePickerFor] = useState<string | null>(null);

  const scheme = useMediaScheme();
  const wide = useWideLayout();
  const flavor = resolveFlavor(prefs.theme, scheme);
  const theme = UI_THEMES[flavor];
  const layout = sidebarLayout({ wide, sidebarPinned: prefs.sidebarPinned, drawerOpen, tabLayout: prefs.tabLayout });

  // Everything tinted in index.css resolves through --lit, so this is what
  // re-colours the app on a session switch. A stopped session tints nothing.
  const { dot: activeDot } = useMemo(
    () => activeSessionDot(app.sessions, app.activeHostId, app.activeSessionId),
    [app.sessions, app.activeHostId, app.activeSessionId],
  );
  const litState = litStateFor(activeDot);

  const shellProps = useShellChrome(litState, {
    ...shellVars(theme, litState),
    background: theme.colors.background,
    color: theme.colors.text,
  });

  return {
    flavor,
    theme,
    wide,
    layout,
    activeDot,
    shellProps,
    drawerOpen,
    setDrawerOpen,
    overflowOpen,
    setOverflowOpen,
    overflowAlign,
    openOverflow: (align: 'start' | 'end') => {
      setOverflowAlign(align);
      setOverflowOpen(true);
    },
    panePickerFor,
    setPanePickerFor,
    // A file viewer/presentation owns the pane while up, so git overlays stand
    // down rather than stack — git returns when the viewer closes.
    fileOrPreviewUp: Boolean(workspace.fileView || workspace.fileLoading || workspace.activePresentation),
  };
}

export type AppChrome = ReturnType<typeof useAppChrome>;

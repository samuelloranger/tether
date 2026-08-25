import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, useWindowDimensions, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { sidebarDocked, wideLayout } from './desktopLayout';
import { isDesktop } from './platform';
import type { RendererStatus } from './rendererLifecycle';
import { createStyles } from './styles';
import { TerminalDesktopChrome } from './TerminalScreenOverlays';
import { useTerminalScreenEffects } from './terminalScreenEffects';
import {
  BellFlash,
  TerminalMainColumn,
  TerminalSessionDrawer,
  TerminalTitleBar,
} from './terminalScreenLayout';
import { useFile, useGit, usePresentation, useSession } from './tether/context';

export function TerminalScreen() {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const { width } = useWindowDimensions();
  const { sidebarPinned } = useSession();
  const { diffOpen } = useGit();
  const { fileView } = useFile();
  const { activePresentation } = usePresentation();
  // Two axes, deliberately separate. `wideUi` is about *space* — a tablet in
  // landscape has as much of it as a desktop window, so it gets the docked
  // sidebar too. `desktopUi` is about *chrome* — title bar, mouse selection,
  // physical keyboard — which stays desktop-only, so an iPad keeps its header
  // and on-screen utility bar beside the docked sidebar.
  const wideUi = wideLayout(width);
  const desktopUi = isDesktop && wideUi;
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>('loading');
  const docked = sidebarDocked(wideUi, sidebarPinned);
  // The Changes split pane is a mouse-resized desktop affordance; touch clients
  // keep the full-screen review takeover regardless of width.
  const gitTakeover = diffOpen && !desktopUi;
  const terminalVisible = !fileView && !gitTakeover && !activePresentation;
  const bellFlash = useTerminalScreenEffects(terminalVisible);
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.terminalContainer}
    >
      <BellFlash visible={bellFlash} color={theme.colors.danger} />
      <TerminalTitleBar desktopUi={desktopUi} terminalVisible={terminalVisible} />
      <View style={[styles.terminalBody, docked && styles.terminalRow]}>
        <TerminalSessionDrawer wideUi={wideUi} docked={docked} />
        <TerminalMainColumn
          styles={styles}
          desktopUi={desktopUi}
          docked={docked}
          gitTakeover={gitTakeover}
          terminalVisible={terminalVisible}
          rendererStatus={rendererStatus}
          onStatus={setRendererStatus}
        />
      </View>
      <TerminalDesktopChrome />
    </KeyboardAvoidingView>
  );
}

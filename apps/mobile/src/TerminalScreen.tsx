import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, useWindowDimensions, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { desktopLayout, sidebarDocked } from './desktopLayout';
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
  const desktopUi = desktopLayout(isDesktop, width) === 'desktop';
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>('loading');
  const docked = sidebarDocked(desktopUi, sidebarPinned);
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
        <TerminalSessionDrawer desktopUi={desktopUi} docked={docked} />
        <TerminalMainColumn
          styles={styles}
          desktopUi={desktopUi}
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

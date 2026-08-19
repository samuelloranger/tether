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
import type { TetherApp } from './terminalScreenTypes';

export function TerminalScreen({ app }: { app: TetherApp }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const { width } = useWindowDimensions();
  const desktopUi = desktopLayout(isDesktop, width) === 'desktop';
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>('loading');
  const docked = sidebarDocked(desktopUi, app.sidebarPinned);
  const gitTakeover = app.diffOpen && !desktopUi;
  const terminalVisible = !app.fileView && !gitTakeover && !app.activePresentation;
  const bellFlash = useTerminalScreenEffects(app, terminalVisible);
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.terminalContainer}
    >
      <BellFlash visible={bellFlash} color={theme.colors.danger} />
      <TerminalTitleBar app={app} desktopUi={desktopUi} terminalVisible={terminalVisible} />
      <View style={[styles.terminalBody, docked && styles.terminalRow]}>
        <TerminalSessionDrawer app={app} desktopUi={desktopUi} docked={docked} />
        <TerminalMainColumn
          app={app}
          styles={styles}
          desktopUi={desktopUi}
          gitTakeover={gitTakeover}
          terminalVisible={terminalVisible}
          rendererStatus={rendererStatus}
          onStatus={setRendererStatus}
        />
      </View>
      <TerminalDesktopChrome app={app} />
    </KeyboardAvoidingView>
  );
}

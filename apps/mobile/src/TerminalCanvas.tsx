import { DragDropContentView } from 'expo-drag-drop-content-view';
import { Platform, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { ConnectionBanner } from './ConnectionBanner';
import { isDesktop } from './platform';
import type { RendererStatus } from './rendererLifecycle';
import { TerminalView } from './TerminalView';
import type { TerminalStyles, TetherApp } from './terminalScreenTypes';

function TerminalRenderer({
  app,
  onStatus,
}: {
  app: TetherApp;
  onStatus: (status: RendererStatus) => void;
}) {
  const viewProps = {
    ref: app.terminalViewRef,
    onResize: app.onRendererResize,
    onOpenLink: app.openFile,
    onSelection: app.onRendererSelection,
    onControl: app.onPageControl,
    onReply: app.onPageReply,
    onClipboardWrite: app.onPageClipboardWrite,
    onPaste: app.handlePaste,
    onNewTerminal: app.newTerminal,
    onFontZoom: app.changeFontSize,
    onFallback: (reason: string) => console.warn('Terminal renderer fallback:', reason),
    onRecover: app.hydrateRenderer,
    onStatus,
  };
  if (Platform.OS === 'ios') {
    return (
      <DragDropContentView
        style={{ flex: 1 }}
        onDrop={(event) => {
          for (const asset of event.assets) {
            if (!asset.uri) continue;
            const filename = asset.fileName || `drop-${Date.now()}`;
            app.uploadFile({ uri: asset.uri, name: filename, type: asset.type }, filename);
          }
        }}
      >
        <TerminalView {...viewProps} onInput={app.sendTyped} />
      </DragDropContentView>
    );
  }
  return <TerminalView {...viewProps} onInput={isDesktop ? app.sendKey : app.sendTyped} />;
}

function RendererStalled({ styles, onRetry }: { styles: TerminalStyles; onRetry: () => void }) {
  return (
    <View style={styles.rendererStalled}>
      <Text style={styles.rendererStalledText}>
        The terminal display stopped responding. Your session is still running on the server —
        reloading only redraws it.
      </Text>
      <TouchableOpacity
        style={styles.rendererStalledButton}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Reload terminal display"
      >
        <Text style={styles.rendererStalledButtonText}>Reload display</Text>
      </TouchableOpacity>
    </View>
  );
}

function DeepLinkNotice({
  notice,
  onDismiss,
  surface,
  muted,
}: {
  notice: string;
  onDismiss: () => void;
  surface: string;
  muted: string;
}) {
  return (
    <TouchableOpacity
      onPress={onDismiss}
      accessibilityRole="button"
      accessibilityLabel="Dismiss deep link notice"
      style={{
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: 10,
        padding: 10,
        borderRadius: 8,
        backgroundColor: surface,
      }}
    >
      <Text style={{ color: muted, fontSize: 12 }}>{notice}</Text>
    </TouchableOpacity>
  );
}

export function TerminalCanvas({
  app,
  styles,
  rendererStatus,
  onStatus,
}: {
  app: TetherApp;
  styles: TerminalStyles;
  rendererStatus: RendererStatus;
  onStatus: (status: RendererStatus) => void;
}) {
  const { theme } = useAppTheme();
  const { insets, connectionStatus, hasConnected, setIsConfiguring, deepLinkNotice } = app;
  return (
    <View style={styles.terminalArea}>
      <View
        nativeID="tether-terminal"
        style={[
          styles.terminalScroll,
          {
            backgroundColor: theme.terminal.bg,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        <TerminalRenderer app={app} onStatus={onStatus} />
      </View>
      {rendererStatus === 'stalled' && (
        <RendererStalled styles={styles} onRetry={() => app.terminalViewRef.current?.retry()} />
      )}
      <View style={styles.connectionBannerOverlay} pointerEvents="box-none">
        <ConnectionBanner
          status={connectionStatus}
          hasConnected={hasConnected}
          onEdit={() => setIsConfiguring(true)}
        />
      </View>
      {deepLinkNotice && (
        <DeepLinkNotice
          notice={deepLinkNotice}
          onDismiss={app.dismissDeepLinkNotice}
          surface={theme.colors.surfaceRaised}
          muted={theme.colors.textMuted}
        />
      )}
    </View>
  );
}

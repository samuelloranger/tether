import { ActivityIndicator, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { ChangeBanner } from './ChangeBanner';
import { FileViewer } from './FileViewer';
import { GitDrawer } from './GitDrawer';
import { GitReview } from './GitReview';
import { PresentationBanner } from './PresentationBanner';
import { PresentationView } from './PresentationView';
import { findSessionPreview, previewUrl } from './presentations';
import { sessionLabel } from './sessionLabel';
import type { TerminalStyles, TetherApp } from './terminalScreenTypes';

export function GitReviewPane({ app }: { app: TetherApp }) {
  return (
    <GitReview
      summary={app.changeSummary}
      onBack={app.closeDiff}
      onStageFile={app.stageFile}
      onUnstageFile={app.unstageFile}
      onDiscardFile={app.discardFile}
      onToggleHunk={app.toggleHunk}
      onCommit={app.commitStagedChanges}
      onAmend={(message) => app.commitStagedChanges(message, true)}
      onUndoCommit={() => void app.undoLastCommit()}
      onPush={() => void app.pushChanges()}
      onStageAll={() => void app.stageAllFiles()}
      onUnstageAll={() => void app.unstageAllFiles()}
      onDiscardAll={() => void app.discardAllFiles()}
      onOpenLine={app.openDiffFileLine}
      repoStatus={app.repoStatus}
      historyEntries={app.historyEntries}
      historyCommit={app.historyCommit}
      onLoadHistory={app.loadGitLog}
      onSelectCommit={app.selectCommit}
      reviewDiffs={app.reviewDiffs}
      onRetryReviewDiff={app.retryReviewDiff}
      loadReviewDiffs={app.loadReviewDiffs}
    />
  );
}

export function GitDrawerPane({ app }: { app: TetherApp }) {
  return (
    <GitDrawer
      summary={app.changeSummary}
      selectedPath={app.diffSelectedPath}
      diffMode={app.diffMode}
      diffText={app.diffText}
      diffTruncated={app.diffTruncated}
      diffLoading={app.diffLoading}
      diffImage={app.diffImage}
      onSelectFile={app.selectDiffFile}
      onDeselectFile={app.deselectDiffFile}
      onBack={app.closeDiff}
      onStageFile={app.stageFile}
      onUnstageFile={app.unstageFile}
      onDiscardFile={app.discardFile}
      onToggleHunk={app.toggleHunk}
      onCommit={app.commitStagedChanges}
      onAmend={(message) => app.commitStagedChanges(message, true)}
      onUndoCommit={() => void app.undoLastCommit()}
      onPush={() => void app.pushChanges()}
      onStageAll={() => void app.stageAllFiles()}
      onUnstageAll={() => void app.unstageAllFiles()}
      onDiscardAll={() => void app.discardAllFiles()}
      onOpenLine={app.openDiffFileLine}
      repoStatus={app.repoStatus}
      leftWidthStorageKey={app.gitDrawerLeftWidthKey}
      historyEntries={app.historyEntries}
      historyCommit={app.historyCommit}
      onLoadHistory={app.loadGitLog}
      onSelectCommit={app.selectCommit}
      sideBySide={app.diffSideBySide}
      onToggleSideBySide={app.toggleDiffSideBySide}
    />
  );
}

export function PresentationPane({ app, desktopUi }: { app: TetherApp; desktopUi: boolean }) {
  const preview = app.activePresentation;
  if (!preview) return null;
  const backTarget = preview.sessionId ?? app.activeId;
  const backSession = app.drawerSessions.find((s) => s.id === backTarget);
  const backLabel = backSession ? sessionLabel(backSession) : backTarget;
  return (
    <>
      {!desktopUi && (
        <PresentationBanner
          label={`Back to ${backLabel}`}
          icon="terminal"
          onPress={() => app.selectTerminal(app.activeHostId, backTarget)}
        />
      )}
      <View
        style={{
          flex: 1,
          paddingBottom: app.insets.bottom,
          paddingLeft: app.insets.left,
          paddingRight: app.insets.right,
        }}
      >
        <PresentationView preview={preview} url={previewUrl(app.client, preview.url)} />
      </View>
    </>
  );
}

export function FileOverlay({ app, styles }: { app: TetherApp; styles: TerminalStyles }) {
  if (!app.fileView) return null;
  return (
    <View
      style={[
        styles.fileOverlay,
        {
          paddingBottom: app.insets.bottom,
          paddingLeft: app.insets.left,
          paddingRight: app.insets.right,
        },
      ]}
      pointerEvents="box-none"
    >
      <FileViewer
        file={app.fileView}
        onBack={app.closeFile}
        backLabel={app.diffOpen ? 'Back to changes' : 'Back to terminal'}
      />
    </View>
  );
}

export function TerminalBanners({ app }: { app: TetherApp }) {
  const sessionPreview = findSessionPreview(app.presentations, app.activeId);
  return (
    <>
      {!app.diffOpen && <ChangeBanner summary={app.changeSummary} onPress={app.openDiff} />}
      {sessionPreview && (
        <PresentationBanner
          label={`Preview ready: ${sessionPreview.title}`}
          icon="layout"
          onPress={() => app.selectPresentation(sessionPreview.id)}
        />
      )}
    </>
  );
}

export function FileLoadingCover({ loading }: { loading: boolean }) {
  const { theme } = useAppTheme();
  if (!loading) return null;
  return (
    <View
      style={{
        position: 'absolute',
        inset: 0,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 61,
      }}
    >
      <ActivityIndicator color={theme.colors.accent} />
    </View>
  );
}

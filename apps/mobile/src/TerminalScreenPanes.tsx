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
import type { TerminalStyles } from './terminalScreenTypes';
import { useChrome, useFile, useGit, usePresentation, useSession } from './tether/context';

export function GitReviewPane() {
  const git = useGit();
  return (
    <GitReview
      summary={git.changeSummary}
      onBack={git.closeDiff}
      onStageFile={git.stageFile}
      onUnstageFile={git.unstageFile}
      onDiscardFile={git.discardFile}
      onToggleHunk={git.toggleHunk}
      onCommit={git.commitStagedChanges}
      onAmend={(message) => git.commitStagedChanges(message, true)}
      onUndoCommit={() => void git.undoLastCommit()}
      onPush={() => void git.pushChanges()}
      onStageAll={() => void git.stageAllFiles()}
      onUnstageAll={() => void git.unstageAllFiles()}
      onDiscardAll={() => void git.discardAllFiles()}
      onOpenLine={git.openDiffFileLine}
      repoStatus={git.repoStatus}
      historyEntries={git.historyEntries}
      historyCommit={git.historyCommit}
      onLoadHistory={git.loadGitLog}
      onSelectCommit={git.selectCommit}
      reviewDiffs={git.reviewDiffs}
      onRetryReviewDiff={git.retryReviewDiff}
      loadReviewDiffs={git.loadReviewDiffs}
    />
  );
}

export function GitDrawerPane() {
  const git = useGit();
  return (
    <GitDrawer
      summary={git.changeSummary}
      selectedPath={git.diffSelectedPath}
      diffMode={git.diffMode}
      diffText={git.diffText}
      diffTruncated={git.diffTruncated}
      diffLoading={git.diffLoading}
      diffImage={git.diffImage}
      onSelectFile={git.selectDiffFile}
      onDeselectFile={git.deselectDiffFile}
      onBack={git.closeDiff}
      onStageFile={git.stageFile}
      onUnstageFile={git.unstageFile}
      onDiscardFile={git.discardFile}
      onToggleHunk={git.toggleHunk}
      onCommit={git.commitStagedChanges}
      onAmend={(message) => git.commitStagedChanges(message, true)}
      onUndoCommit={() => void git.undoLastCommit()}
      onPush={() => void git.pushChanges()}
      onStageAll={() => void git.stageAllFiles()}
      onUnstageAll={() => void git.unstageAllFiles()}
      onDiscardAll={() => void git.discardAllFiles()}
      onOpenLine={git.openDiffFileLine}
      repoStatus={git.repoStatus}
      leftWidthStorageKey={git.gitDrawerLeftWidthKey}
      historyEntries={git.historyEntries}
      historyCommit={git.historyCommit}
      onLoadHistory={git.loadGitLog}
      onSelectCommit={git.selectCommit}
      sideBySide={git.diffSideBySide}
      onToggleSideBySide={git.toggleDiffSideBySide}
    />
  );
}

export function PresentationPane({ desktopUi }: { desktopUi: boolean }) {
  const { insets } = useChrome();
  const { activePresentation, selectTerminal } = usePresentation();
  const { activeId, activeHostId, drawerSessions, client } = useSession();
  const preview = activePresentation;
  if (!preview) return null;
  const backTarget = preview.sessionId ?? activeId;
  const backSession = drawerSessions.find((s) => s.id === backTarget);
  const backLabel = backSession ? sessionLabel(backSession) : backTarget;
  return (
    <>
      {!desktopUi && (
        <PresentationBanner
          label={`Back to ${backLabel}`}
          icon="terminal"
          onPress={() => selectTerminal(activeHostId, backTarget)}
        />
      )}
      <View
        style={{
          flex: 1,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        <PresentationView preview={preview} url={previewUrl(client, preview.url)} />
      </View>
    </>
  );
}

export function FileOverlay({ styles }: { styles: TerminalStyles }) {
  const { insets } = useChrome();
  const { fileView, closeFile } = useFile();
  const { diffOpen } = useGit();
  if (!fileView) return null;
  return (
    <View
      style={[
        styles.fileOverlay,
        {
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
      pointerEvents="box-none"
    >
      <FileViewer
        file={fileView}
        onBack={closeFile}
        backLabel={diffOpen ? 'Back to changes' : 'Back to terminal'}
      />
    </View>
  );
}

export function TerminalBanners() {
  const { activeId } = useSession();
  const { presentations, selectPresentation } = usePresentation();
  const { diffOpen, changeSummary, openDiff } = useGit();
  const sessionPreview = findSessionPreview(presentations, activeId);
  return (
    <>
      {!diffOpen && <ChangeBanner summary={changeSummary} onPress={openDiff} />}
      {sessionPreview && (
        <PresentationBanner
          label={`Preview ready: ${sessionPreview.title}`}
          icon="layout"
          onPress={() => selectPresentation(sessionPreview.id)}
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

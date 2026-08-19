import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { groupSummary, isImagePath } from './diffModel';
import { GitTabBar } from './GitTabBar';
import {
  GitDrawerHeader,
  GitDrawerLeftPane,
  type GitDrawerLeftPaneProps,
  GitDrawerRightPane,
  type GitDrawerRightPaneProps,
  GitDrawerSplitter,
  SIDE_BY_SIDE_MIN_WIDTH,
} from './gitDrawerPanes';
import { gitDrawerStyles as styles } from './gitDrawerStyles';
import type { GitPanelSharedProps } from './gitPanelProps';
import { formatRepoStatusLabel } from './gitStatusModel';
import { useGitCommitForm } from './useGitCommitForm';
import { useGitDrawerLayout } from './useGitDrawerLayout';

export type GitDrawerProps = GitPanelSharedProps & {
  selectedPath: string | null;
  diffMode: 'staged' | 'unstaged' | null;
  diffText: string | null;
  diffTruncated: boolean;
  diffLoading: boolean;
  diffImage: { old: string | null; new: string | null } | null;
  onSelectFile: (path: string, mode?: 'staged' | 'unstaged') => void;
  onDeselectFile: () => void;
  leftWidthStorageKey: string;
  sideBySide: boolean;
  onToggleSideBySide: () => void;
};

function leftPaneProps(
  p: GitDrawerProps,
  theme: GitDrawerLeftPaneProps['theme'],
  tab: 'changes' | 'history',
  collapsedDirs: Set<string>,
  setCollapsedDirs: (update: (prev: Set<string>) => Set<string>) => void,
  form: ReturnType<typeof useGitCommitForm>,
): GitDrawerLeftPaneProps {
  return {
    theme,
    tab,
    summary: p.summary,
    groups: groupSummary(p.summary),
    historyEntries: p.historyEntries,
    onSelectCommit: p.onSelectCommit,
    collapsedDirs,
    setCollapsedDirs,
    onSelectFile: p.onSelectFile,
    onUnstageFile: p.onUnstageFile,
    onStageFile: p.onStageFile,
    onDiscardFile: p.onDiscardFile,
    onUnstageAll: p.onUnstageAll,
    onStageAll: p.onStageAll,
    onDiscardAll: p.onDiscardAll,
    form,
    repoStatus: p.repoStatus,
    onUndoCommit: p.onUndoCommit,
    onPush: p.onPush,
  };
}

function rightPaneProps(
  p: GitDrawerProps,
  theme: GitDrawerRightPaneProps['theme'],
  viewingCommit: boolean,
  wideEnough: boolean,
): GitDrawerRightPaneProps {
  return {
    theme,
    viewingCommit,
    historyCommit: p.historyCommit,
    selectedPath: p.selectedPath,
    selectedFile: p.summary.files.find((file) => file.path === p.selectedPath) ?? null,
    diffLoading: p.diffLoading,
    diffText: p.diffText,
    diffTruncated: p.diffTruncated,
    diffImage: p.diffImage,
    diffMode: p.diffMode,
    sideBySide: p.sideBySide,
    wideEnough,
    onToggleHunk: p.onToggleHunk,
    onOpenLine: p.onOpenLine,
  };
}

function drawerTitle(
  viewingCommit: boolean,
  historyCommit: GitDrawerProps['historyCommit'],
  selectedPath: string | null,
) {
  if (viewingCommit && historyCommit) {
    return `${historyCommit.entry.shortSha} ${historyCommit.entry.subject}`;
  }
  return selectedPath ?? 'Working tree';
}

export function GitDrawer(p: GitDrawerProps) {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const form = useGitCommitForm(p.onCommit, p.onAmend);
  const selectedFile = p.summary.files.find((file) => file.path === p.selectedPath) ?? null;
  const isImage = selectedFile ? selectedFile.binary && isImagePath(selectedFile.path) : false;
  const wideEnough = width >= SIDE_BY_SIDE_MIN_WIDTH;
  const viewingCommit = tab === 'history' && p.historyCommit !== null;
  const layout = useGitDrawerLayout({
    leftWidthStorageKey: p.leftWidthStorageKey,
    viewingCommit,
    selectedPath: p.selectedPath,
    onBack: p.onBack,
    onDeselectFile: p.onDeselectFile,
    onSelectCommit: p.onSelectCommit,
  });
  return (
    <View
      ref={layout.drawerRef}
      style={[
        styles.root,
        { backgroundColor: theme.colors.background, borderLeftColor: theme.colors.border },
      ]}
    >
      <GitDrawerHeader
        theme={theme}
        onBack={p.onBack}
        headerLabel={drawerTitle(viewingCommit, p.historyCommit, p.selectedPath)}
        statusLabel={formatRepoStatusLabel(p.repoStatus)}
        viewingCommit={viewingCommit}
        selectedPath={p.selectedPath}
        isImage={isImage}
        wideEnough={wideEnough}
        sideBySide={p.sideBySide}
        onToggleSideBySide={p.onToggleSideBySide}
      />
      <GitTabBar
        tab={tab}
        onChanges={() => {
          setTab('changes');
          p.onSelectCommit(null);
        }}
        onHistory={() => {
          setTab('history');
          p.onLoadHistory();
        }}
      />
      <View style={styles.body} onLayout={layout.onBodyLayout}>
        <View
          style={[
            styles.left,
            layout.resolvedLeft !== null ? { width: layout.resolvedLeft } : styles.leftFallback,
          ]}
        >
          <GitDrawerLeftPane
            {...leftPaneProps(p, theme, tab, collapsedDirs, setCollapsedDirs, form)}
          />
        </View>
        <GitDrawerSplitter
          theme={theme}
          bodyWidth={layout.bodyWidth}
          resolvedLeft={layout.resolvedLeft}
          setLeftWidth={layout.setLeftWidth}
          storageKey={p.leftWidthStorageKey}
          onSplitterGrant={layout.onSplitterGrant}
          startResize={layout.startResize}
        />
        <View style={styles.right}>
          <GitDrawerRightPane {...rightPaneProps(p, theme, viewingCommit, wideEnough)} />
        </View>
      </View>
    </View>
  );
}

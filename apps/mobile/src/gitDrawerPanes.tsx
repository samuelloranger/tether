import Feather from '@expo/vector-icons/Feather';
import type { GestureResponderEvent } from 'react-native';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import type { AppTheme } from './appTheme';
import { CommitBox } from './CommitBox';
import { DiffFileBody } from './DiffFileBody';
import { buildFileTree, type DiffSummary, type groupSummary, isImagePath } from './diffModel';
import { FileTree } from './FileTree';
import { GitSectionAction, GitSectionActions, GitSectionHeader } from './GitSectionHeader';
import { gitDrawerStyles as styles } from './gitDrawerStyles';
import type { GitPanelSharedProps } from './gitPanelProps';
import { toggleSetMember } from './gitReviewModel';
import { canPushHead, canRewriteHead } from './gitStatusModel';
import { HistoryList } from './HistoryList';
import { PanelHeader } from './PanelHeader';
import type { useGitCommitForm } from './useGitCommitForm';
import { applyGitDrawerA11yResize } from './useGitDrawerLayout';

export const SIDE_BY_SIDE_MIN_WIDTH = 900;

type Groups = ReturnType<typeof groupSummary>;
type CollapseSetter = (update: (prev: Set<string>) => Set<string>) => void;

export type GitDrawerHeaderProps = {
  theme: AppTheme;
  onBack: () => void;
  headerLabel: string;
  statusLabel: string | null;
  viewingCommit: boolean;
  selectedPath: string | null;
  isImage: boolean;
  wideEnough: boolean;
  sideBySide: boolean;
  onToggleSideBySide: () => void;
};

export function GitDrawerHeader(p: GitDrawerHeaderProps) {
  const showToggle = (p.selectedPath || p.viewingCommit) && !p.isImage && p.wideEnough;
  return (
    <PanelHeader
      onBack={p.onBack}
      backAccessibilityLabel="Close git drawer"
      backText="Close"
      title={p.headerLabel}
      subtitle={p.statusLabel && !p.viewingCommit ? p.statusLabel : null}
      right={
        showToggle ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={p.sideBySide ? 'Unified view' : 'Side-by-side view'}
            onPress={p.onToggleSideBySide}
            style={styles.iconButton}
          >
            <Feather
              name={p.sideBySide ? 'square' : 'columns'}
              size={16}
              color={p.theme.colors.accent}
            />
          </TouchableOpacity>
        ) : null
      }
    />
  );
}

export type GitDrawerRightPaneProps = {
  theme: AppTheme;
  viewingCommit: boolean;
  historyCommit: GitPanelSharedProps['historyCommit'];
  selectedPath: string | null;
  selectedFile: DiffSummary['files'][number] | null;
  diffLoading: boolean;
  diffText: string | null;
  diffTruncated: boolean;
  diffImage: { old: string | null; new: string | null } | null;
  diffMode: 'staged' | 'unstaged' | null;
  sideBySide: boolean;
  wideEnough: boolean;
  onToggleHunk: GitPanelSharedProps['onToggleHunk'];
  onOpenLine: GitPanelSharedProps['onOpenLine'];
};

export function GitDrawerRightPane(p: GitDrawerRightPaneProps) {
  const isImage = p.selectedFile
    ? p.selectedFile.binary && isImagePath(p.selectedFile.path)
    : false;
  if (p.viewingCommit && p.historyCommit) {
    return (
      <DiffFileBody
        loading={p.historyCommit.diff === null}
        path=""
        diffText={p.historyCommit.diff}
        truncated={p.historyCommit.truncated}
        sideBySide={p.sideBySide}
        wideEnough={p.wideEnough}
      />
    );
  }
  if (!p.selectedPath) {
    return (
      <View style={styles.center}>
        <Text style={{ color: p.theme.colors.textMuted }}>Select a file to review</Text>
      </View>
    );
  }
  const path = p.selectedPath;
  return (
    <DiffFileBody
      loading={p.diffLoading}
      path={path}
      diffText={p.diffText}
      truncated={p.diffTruncated}
      image={isImage ? (p.diffImage ?? { old: null, new: null }) : null}
      sideBySide={p.sideBySide}
      wideEnough={p.wideEnough}
      onHunkPress={
        p.diffMode
          ? (hunkIndex) => p.onToggleHunk(path, hunkIndex, p.diffMode === 'staged')
          : undefined
      }
      hunkActionLabel={p.diffMode === 'staged' ? 'Unstage' : 'Stage'}
      onOpenLine={(line) => p.onOpenLine(path, line)}
    />
  );
}

type StagedTreeProps = {
  groups: Groups;
  collapsedDirs: Set<string>;
  setCollapsedDirs: CollapseSetter;
  onSelectFile: (path: string, mode?: 'staged' | 'unstaged') => void;
  onUnstageFile: (path: string) => void;
  onUnstageAll: () => void;
};

function StagedTree(p: StagedTreeProps) {
  if (p.groups.staged.length === 0) return null;
  return (
    <>
      <GitSectionHeader
        label="Staged"
        count={p.groups.staged.length}
        actions={<GitSectionAction label="Unstage all" onPress={p.onUnstageAll} />}
      />
      <FileTree
        nodes={buildFileTree(p.groups.staged)}
        collapseScope="staged"
        collapsedDirs={p.collapsedDirs}
        onToggleDir={(key) => p.setCollapsedDirs((prev) => toggleSetMember(prev, key))}
        onSelectFile={(path) => p.onSelectFile(path, 'staged')}
        fileActions={[{ icon: 'minus', label: 'Unstage', onPress: p.onUnstageFile }]}
      />
    </>
  );
}

type UnstagedTreeProps = {
  groups: Groups;
  collapsedDirs: Set<string>;
  setCollapsedDirs: CollapseSetter;
  onSelectFile: (path: string, mode?: 'staged' | 'unstaged') => void;
  onStageFile: (path: string) => void;
  onDiscardFile: (path: string) => void;
  onStageAll: () => void;
  onDiscardAll: () => void;
};

function UnstagedTree(p: UnstagedTreeProps) {
  if (p.groups.unstaged.length === 0) return null;
  return (
    <>
      <GitSectionHeader
        label="Changes"
        count={p.groups.unstaged.length}
        actions={
          <GitSectionActions>
            <GitSectionAction label="Stage all" onPress={p.onStageAll} />
            <GitSectionAction label="Discard all" onPress={p.onDiscardAll} danger />
          </GitSectionActions>
        }
      />
      <FileTree
        nodes={buildFileTree(p.groups.unstaged)}
        collapseScope="unstaged"
        collapsedDirs={p.collapsedDirs}
        onToggleDir={(key) => p.setCollapsedDirs((prev) => toggleSetMember(prev, key))}
        onSelectFile={(path) => p.onSelectFile(path, 'unstaged')}
        fileActions={[
          { icon: 'plus', label: 'Stage', onPress: p.onStageFile },
          { icon: 'trash-2', label: 'Discard', destructive: true, onPress: p.onDiscardFile },
        ]}
      />
    </>
  );
}

export type GitDrawerLeftPaneProps = {
  theme: AppTheme;
  tab: 'changes' | 'history';
  summary: DiffSummary;
  groups: Groups;
  historyEntries: GitPanelSharedProps['historyEntries'];
  onSelectCommit: GitPanelSharedProps['onSelectCommit'];
  collapsedDirs: Set<string>;
  setCollapsedDirs: CollapseSetter;
  onSelectFile: (path: string, mode?: 'staged' | 'unstaged') => void;
  onUnstageFile: (path: string) => void;
  onStageFile: (path: string) => void;
  onDiscardFile: (path: string) => void;
  onUnstageAll: () => void;
  onStageAll: () => void;
  onDiscardAll: () => void;
  form: ReturnType<typeof useGitCommitForm>;
  repoStatus: GitPanelSharedProps['repoStatus'];
  onUndoCommit: () => void;
  onPush: () => void;
};

export function GitDrawerLeftPane(p: GitDrawerLeftPaneProps) {
  if (p.tab === 'history') {
    return <HistoryList entries={p.historyEntries} onSelect={p.onSelectCommit} />;
  }
  if (p.summary.files.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={{ color: p.theme.colors.text }}>No uncommitted changes</Text>
      </View>
    );
  }
  return (
    <>
      <ScrollView contentContainerStyle={styles.listContent}>
        <StagedTree
          groups={p.groups}
          collapsedDirs={p.collapsedDirs}
          setCollapsedDirs={p.setCollapsedDirs}
          onSelectFile={p.onSelectFile}
          onUnstageFile={p.onUnstageFile}
          onUnstageAll={p.onUnstageAll}
        />
        <UnstagedTree
          groups={p.groups}
          collapsedDirs={p.collapsedDirs}
          setCollapsedDirs={p.setCollapsedDirs}
          onSelectFile={p.onSelectFile}
          onStageFile={p.onStageFile}
          onDiscardFile={p.onDiscardFile}
          onStageAll={p.onStageAll}
          onDiscardAll={p.onDiscardAll}
        />
      </ScrollView>
      <CommitBox
        message={p.form.commitMessage}
        onChangeMessage={p.form.setCommitMessage}
        onCommit={() => void p.form.submitCommit()}
        onAmend={() => void p.form.submitAmend()}
        onUndoCommit={p.onUndoCommit}
        onPush={p.onPush}
        canAmend={canRewriteHead(p.repoStatus)}
        canPush={canPushHead(p.repoStatus)}
        stagedCount={p.groups.staged.length}
        committing={p.form.committing}
      />
    </>
  );
}

export type GitDrawerSplitterProps = {
  theme: AppTheme;
  bodyWidth: number;
  resolvedLeft: number | null;
  setLeftWidth: (n: number) => void;
  storageKey: string;
  onSplitterGrant: (event: GestureResponderEvent) => void;
  startResize: (clientX: number) => void;
};

export function GitDrawerSplitter(p: GitDrawerSplitterProps) {
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel="Resize file list"
      accessibilityValue={{
        min: 0,
        max: Math.max(0, p.bodyWidth),
        now: p.resolvedLeft ?? 0,
      }}
      accessibilityActions={[
        { name: 'increment', label: 'Widen file list' },
        { name: 'decrement', label: 'Narrow file list' },
      ]}
      onAccessibilityAction={(event) => {
        applyGitDrawerA11yResize(
          event.nativeEvent.actionName,
          p.bodyWidth,
          p.resolvedLeft,
          p.setLeftWidth,
          p.storageKey,
        );
      }}
      hitSlop={{ left: 4, right: 4, top: 0, bottom: 0 }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={p.onSplitterGrant}
      {...({
        onPointerDown: (event: { clientX: number }) => p.startResize(event.clientX),
      } as object)}
      style={[styles.splitterHit, { cursor: 'col-resize' } as object]}
    >
      <View style={[styles.splitterLine, { backgroundColor: p.theme.colors.border }]} />
    </View>
  );
}

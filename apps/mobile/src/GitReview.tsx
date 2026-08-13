import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import { DiffFileBody } from './DiffFileBody';
import { groupSummary } from './diffModel';
import type { ReviewDiffSlot } from './fetchReviewDiff';
import { GitTabBar } from './GitTabBar';
import type { GitPanelSharedProps } from './gitPanelProps';
import { GitReviewChanges, type GitReviewChangesProps } from './gitReviewChanges';
import { reviewFileEntries } from './gitReviewModel';
import { canPushHead, canRewriteHead, formatRepoStatusLabel } from './gitStatusModel';
import { HistoryList } from './HistoryList';
import { PanelHeader } from './PanelHeader';
import { useGitCommitForm } from './useGitCommitForm';

export type GitReviewProps = GitPanelSharedProps & {
  reviewDiffs: Record<string, ReviewDiffSlot>;
  onRetryReviewDiff: (mode: 'staged' | 'unstaged', path: string) => void;
  loadReviewDiffs?: () => void;
};

function changesProps(
  p: GitReviewProps,
  form: ReturnType<typeof useGitCommitForm>,
  expanded: Set<string>,
  setExpanded: (update: (prev: Set<string>) => Set<string>) => void,
  theme: GitReviewChangesProps['theme'],
): GitReviewChangesProps {
  return {
    theme,
    summary: p.summary,
    groups: groupSummary(p.summary),
    entries: reviewFileEntries(p.summary),
    expanded,
    setExpanded,
    reviewDiffs: p.reviewDiffs,
    onUnstageFile: p.onUnstageFile,
    onStageFile: p.onStageFile,
    onDiscardFile: p.onDiscardFile,
    onToggleHunk: p.onToggleHunk,
    onRetryReviewDiff: p.onRetryReviewDiff,
    onOpenLine: p.onOpenLine,
    commitMessage: form.commitMessage,
    setCommitMessage: form.setCommitMessage,
    committing: form.committing,
    submitCommit: form.submitCommit,
    submitAmend: form.submitAmend,
    onUndoCommit: p.onUndoCommit,
    onPush: p.onPush,
    canAmend: canRewriteHead(p.repoStatus),
    canPush: canPushHead(p.repoStatus),
    onUnstageAll: p.onUnstageAll,
    onStageAll: p.onStageAll,
    onDiscardAll: p.onDiscardAll,
  };
}

function GitReviewPane({
  viewingCommit,
  tab,
  p,
  form,
  expanded,
  setExpanded,
  theme,
}: {
  viewingCommit: boolean;
  tab: 'changes' | 'history';
  p: GitReviewProps;
  form: ReturnType<typeof useGitCommitForm>;
  expanded: Set<string>;
  setExpanded: (update: (prev: Set<string>) => Set<string>) => void;
  theme: GitReviewChangesProps['theme'];
}) {
  if (viewingCommit && p.historyCommit) {
    return (
      <DiffFileBody
        loading={p.historyCommit.diff === null}
        path=""
        diffText={p.historyCommit.diff}
        truncated={p.historyCommit.truncated}
        sideBySide={false}
        wideEnough={false}
      />
    );
  }
  if (tab === 'history') {
    return <HistoryList entries={p.historyEntries} onSelect={p.onSelectCommit} />;
  }
  return <GitReviewChanges {...changesProps(p, form, expanded, setExpanded, theme)} />;
}

export function GitReview(p: GitReviewProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const form = useGitCommitForm(p.onCommit, p.onAmend);
  const viewingCommit = tab === 'history' && p.historyCommit !== null;
  const statusLabel = formatRepoStatusLabel(p.repoStatus);
  const headerLabel =
    viewingCommit && p.historyCommit
      ? `${p.historyCommit.entry.shortSha} ${p.historyCommit.entry.subject}`
      : 'Working tree';
  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.background,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      <PanelHeader
        onBack={viewingCommit ? () => p.onSelectCommit(null) : p.onBack}
        backAccessibilityLabel={viewingCommit ? 'Back to history' : 'Back to terminal'}
        title={headerLabel}
      />
      {statusLabel && !viewingCommit ? (
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.35}
          style={[
            styles.statusLine,
            { color: theme.colors.textMuted, borderBottomColor: theme.colors.border },
          ]}
        >
          {statusLabel}
        </Text>
      ) : null}
      {!viewingCommit ? (
        <GitTabBar
          tab={tab}
          onChanges={() => {
            setTab('changes');
            p.onSelectCommit(null);
            p.loadReviewDiffs?.();
          }}
          onHistory={() => {
            setTab('history');
            p.onLoadHistory();
          }}
        />
      ) : null}
      <GitReviewPane
        viewingCommit={viewingCommit}
        tab={tab}
        p={p}
        form={form}
        expanded={expanded}
        setExpanded={setExpanded}
        theme={theme}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  statusLine: {
    fontFamily: 'monospace',
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});

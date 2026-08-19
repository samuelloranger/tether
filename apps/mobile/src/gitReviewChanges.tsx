import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CommitBox } from './CommitBox';
import type { DiffSummary } from './diffModel';
import { GitSectionAction, GitSectionActions, GitSectionHeader } from './GitSectionHeader';
import { ReviewFileBlock, type ReviewFileBlockProps } from './gitReviewFileBlock';
import type { ReviewFileEntry } from './gitReviewModel';
import { reviewDiffKey } from './gitReviewModel';

type Groups = { staged: DiffSummary['files']; unstaged: DiffSummary['files'] };

type FileBind = Omit<ReviewFileBlockProps, 'mode' | 'path' | 'file'>;

export type GitReviewChangesProps = FileBind & {
  summary: DiffSummary;
  groups: Groups;
  entries: ReviewFileEntry[];
  commitMessage: string;
  setCommitMessage: (value: string) => void;
  committing: boolean;
  submitCommit: () => Promise<void>;
  submitAmend: () => Promise<void>;
  onUndoCommit: () => void;
  onPush: () => void;
  canAmend: boolean;
  canPush: boolean;
  onUnstageAll: () => void;
  onStageAll: () => void;
  onDiscardAll: () => void;
};

function GitReviewFileList({
  groups,
  entries,
  fileBind,
  onUnstageAll,
  onStageAll,
  onDiscardAll,
}: {
  groups: Groups;
  entries: ReviewFileEntry[];
  fileBind: FileBind;
  onUnstageAll: () => void;
  onStageAll: () => void;
  onDiscardAll: () => void;
}) {
  return (
    <>
      {groups.staged.length > 0 ? (
        <GitSectionHeader
          label="Staged"
          count={groups.staged.length}
          padded
          actions={<GitSectionAction label="Unstage all" onPress={onUnstageAll} />}
        />
      ) : null}
      {entries
        .filter((entry) => entry.mode === 'staged')
        .map((entry) => (
          <ReviewFileBlock
            key={reviewDiffKey(entry.mode, entry.path)}
            mode={entry.mode}
            path={entry.path}
            file={entry.file}
            {...fileBind}
          />
        ))}
      {groups.unstaged.length > 0 ? (
        <GitSectionHeader
          label="Changes"
          count={groups.unstaged.length}
          padded
          actions={
            <GitSectionActions>
              <GitSectionAction label="Stage all" onPress={onStageAll} />
              <GitSectionAction label="Discard all" onPress={onDiscardAll} danger />
            </GitSectionActions>
          }
        />
      ) : null}
      {entries
        .filter((entry) => entry.mode === 'unstaged')
        .map((entry) => (
          <ReviewFileBlock
            key={reviewDiffKey(entry.mode, entry.path)}
            mode={entry.mode}
            path={entry.path}
            file={entry.file}
            {...fileBind}
          />
        ))}
    </>
  );
}

function fileBindFrom(p: GitReviewChangesProps): FileBind {
  return {
    theme: p.theme,
    expanded: p.expanded,
    setExpanded: p.setExpanded,
    reviewDiffs: p.reviewDiffs,
    onUnstageFile: p.onUnstageFile,
    onStageFile: p.onStageFile,
    onDiscardFile: p.onDiscardFile,
    onToggleHunk: p.onToggleHunk,
    onRetryReviewDiff: p.onRetryReviewDiff,
    onOpenLine: p.onOpenLine,
  };
}

export function GitReviewChanges(p: GitReviewChangesProps) {
  return (
    <>
      <CommitBox
        message={p.commitMessage}
        onChangeMessage={p.setCommitMessage}
        onCommit={() => void p.submitCommit()}
        onAmend={() => void p.submitAmend()}
        onUndoCommit={p.onUndoCommit}
        onPush={p.onPush}
        canAmend={p.canAmend}
        canPush={p.canPush}
        stagedCount={p.groups.staged.length}
        committing={p.committing}
        menuPlacement="down"
        style={{ borderTopWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth }}
      />
      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: 24 }]}>
        {p.summary.files.length === 0 ? (
          <View style={styles.center}>
            <Text style={{ color: p.theme.colors.text }}>No uncommitted changes</Text>
          </View>
        ) : (
          <GitReviewFileList
            groups={p.groups}
            entries={p.entries}
            fileBind={fileBindFrom(p)}
            onUnstageAll={p.onUnstageAll}
            onStageAll={p.onStageAll}
            onDiscardAll={p.onDiscardAll}
          />
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  scrollContent: { alignItems: 'stretch' },
  center: { padding: 24, alignItems: 'center' },
});

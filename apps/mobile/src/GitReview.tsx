import Feather from '@expo/vector-icons/Feather';
import { type ReactNode, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import { CommitBox } from './CommitBox';
import { DiffFileBody } from './DiffFileBody';
import { type DiffSummary, groupSummary, isImagePath } from './diffModel';
import type { ReviewDiffSlot } from './fetchReviewDiff';
import { GitTabBar } from './GitTabBar';
import { reviewDiffKey, reviewFileEntries, toggleSetMember } from './gitReviewModel';
import {
  canPushHead,
  canRewriteHead,
  formatRepoStatusLabel,
  type RepoStatus,
} from './gitStatusModel';
import { HistoryList } from './HistoryList';
import { minTouchTarget } from './interaction';
import type { GitLogEntry } from './useTetherApp';

const TOUCH_TARGET = minTouchTarget();
const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;

export function GitReview({
  summary,
  onBack,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onToggleHunk,
  onCommit,
  onAmend,
  onUndoCommit,
  onPush,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
  onOpenLine,
  repoStatus,
  historyEntries,
  historyCommit,
  onLoadHistory,
  onSelectCommit,
  reviewDiffs,
  onRetryReviewDiff,
  loadReviewDiffs,
}: {
  summary: DiffSummary;
  onBack: () => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onDiscardFile: (path: string) => void;
  onToggleHunk: (path: string, hunkIndex: number, staged: boolean) => void;
  onCommit: (message: string) => Promise<boolean>;
  onAmend: (message: string) => Promise<boolean>;
  onUndoCommit: () => void;
  onPush: () => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardAll: () => void;
  onOpenLine: (path: string, line: number) => void;
  repoStatus: RepoStatus;
  historyEntries: GitLogEntry[] | null;
  historyCommit: { entry: GitLogEntry; diff: string | null; truncated: boolean } | null;
  onLoadHistory: () => void;
  onSelectCommit: (entry: GitLogEntry | null) => void;
  reviewDiffs: Record<string, ReviewDiffSlot>;
  onRetryReviewDiff: (mode: 'staged' | 'unstaged', path: string) => void;
  loadReviewDiffs?: () => void;
}) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  // Empty = all collapsed. Expanding mounts DiffLines; keep closed by default so
  // opening review with many files does not paint every unified diff at once.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

  const groups = groupSummary(summary);
  const entries = reviewFileEntries(summary);
  const viewingCommit = tab === 'history' && historyCommit !== null;
  const statusLabel = formatRepoStatusLabel(repoStatus);
  const canAmend = canRewriteHead(repoStatus);
  const canPush = canPushHead(repoStatus);

  const submitCommit = async () => {
    if (!commitMessage.trim() || committing) return;
    setCommitting(true);
    const ok = await onCommit(commitMessage.trim());
    setCommitting(false);
    if (ok) setCommitMessage('');
  };

  const submitAmend = async () => {
    if (!commitMessage.trim() || committing) return;
    setCommitting(true);
    const ok = await onAmend(commitMessage.trim());
    setCommitting(false);
    if (ok) setCommitMessage('');
  };

  const headerLabel = viewingCommit
    ? `${historyCommit.entry.shortSha} ${historyCommit.entry.subject}`
    : 'Working tree';

  const backTarget = viewingCommit ? () => onSelectCommit(null) : onBack;
  const backLabel = viewingCommit ? 'Back to history' : 'Back to terminal';

  const sectionHeader = (label: string, count: number, actions?: ReactNode) => (
    <View style={styles.sectionHeaderRow}>
      <Text style={[styles.sectionHeader, { color: theme.colors.textMuted }]}>
        {label} ({count})
      </Text>
      {actions}
    </View>
  );

  const renderFileBlock = (
    mode: 'staged' | 'unstaged',
    path: string,
    file: (typeof entries)[number]['file'],
  ) => {
    const key = reviewDiffKey(mode, path);
    const isExpanded = expanded.has(key);
    const slot = reviewDiffs[key];
    const stats = file.binary ? (
      <Text style={[styles.fileStat, { color: theme.colors.textMuted }]}>binary</Text>
    ) : (
      <Text style={styles.fileStat}>
        <Text style={{ color: theme.colors.success }}>+{file.insertions}</Text>{' '}
        <Text style={{ color: theme.colors.danger }}>-{file.deletions}</Text>
      </Text>
    );

    return (
      <View key={key} style={[styles.fileBlock, { borderBottomColor: theme.colors.border }]}>
        <View style={styles.fileHeader}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${isExpanded ? 'Collapse' : 'Expand'} file ${path}`}
            style={styles.fileHeaderMain}
            onPress={() => setExpanded((prev) => toggleSetMember(prev, key))}
          >
            <Feather
              name={isExpanded ? 'chevron-down' : 'chevron-right'}
              size={16}
              color={theme.colors.textMuted}
            />
            <Text numberOfLines={1} style={[styles.filePath, { color: theme.colors.text }]}>
              {path}
            </Text>
            {stats}
          </TouchableOpacity>
          {mode === 'staged' ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Unstage ${path}`}
              style={styles.actionButton}
              onPress={() => onUnstageFile(path)}
            >
              <Feather name="minus" size={15} color={theme.colors.accent} />
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Stage ${path}`}
                style={styles.actionButton}
                onPress={() => onStageFile(path)}
              >
                <Feather name="plus" size={15} color={theme.colors.accent} />
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Discard ${path}`}
                style={styles.actionButton}
                onPress={() => onDiscardFile(path)}
              >
                <Feather name="trash-2" size={15} color={theme.colors.danger} />
              </TouchableOpacity>
            </>
          )}
        </View>
        {isExpanded ? (
          <View style={styles.fileBody}>
            <DiffFileBody
              loading={!slot || slot.status === 'loading'}
              error={slot?.status === 'error' ? slot.message : null}
              path={path}
              diffText={slot?.status === 'ready' ? slot.text : null}
              truncated={slot?.status === 'ready' ? slot.truncated : false}
              image={
                slot?.status === 'image'
                  ? { old: slot.old, new: slot.new }
                  : file.binary && isImagePath(path)
                    ? { old: null, new: null }
                    : null
              }
              sideBySide={false}
              wideEnough={false}
              scrollable={false}
              onHunkPress={(hunkIndex) => onToggleHunk(path, hunkIndex, mode === 'staged')}
              hunkActionLabel={mode === 'staged' ? 'Unstage' : 'Stage'}
              onRetry={() => onRetryReviewDiff(mode, path)}
              onOpenLine={(line) => onOpenLine(path, line)}
            />
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          onPress={backTarget}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: theme.colors.accent }]}>Back</Text>
        </TouchableOpacity>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.35}
          style={[styles.path, { color: theme.colors.text }]}
        >
          {headerLabel}
        </Text>
      </View>
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
            onSelectCommit(null);
            loadReviewDiffs?.();
          }}
          onHistory={() => {
            setTab('history');
            onLoadHistory();
          }}
        />
      ) : null}

      {viewingCommit ? (
        <DiffFileBody
          loading={historyCommit.diff === null}
          path=""
          diffText={historyCommit.diff}
          truncated={historyCommit.truncated}
          sideBySide={false}
          wideEnough={false}
        />
      ) : tab === 'history' ? (
        <HistoryList entries={historyEntries} onSelect={onSelectCommit} />
      ) : (
        <>
          <CommitBox
            message={commitMessage}
            onChangeMessage={setCommitMessage}
            onCommit={() => void submitCommit()}
            onAmend={() => void submitAmend()}
            onUndoCommit={onUndoCommit}
            onPush={onPush}
            canAmend={canAmend}
            canPush={canPush}
            stagedCount={groups.staged.length}
            committing={committing}
            menuPlacement="down"
            style={{ borderTopWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth }}
          />
          <ScrollView
            contentContainerStyle={[styles.scrollContent, { paddingBottom: 24 + insets.bottom }]}
          >
            {summary.files.length === 0 ? (
              <View style={styles.center}>
                <Text style={{ color: theme.colors.text }}>No uncommitted changes</Text>
              </View>
            ) : (
              <>
                {groups.staged.length > 0
                  ? sectionHeader(
                      'Staged',
                      groups.staged.length,
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Unstage all"
                        onPress={onUnstageAll}
                        style={styles.sectionAction}
                      >
                        <Text
                          style={{ color: theme.colors.accent, fontSize: 12, fontWeight: '600' }}
                        >
                          Unstage all
                        </Text>
                      </TouchableOpacity>,
                    )
                  : null}
                {entries
                  .filter((e) => e.mode === 'staged')
                  .map((e) => renderFileBlock(e.mode, e.path, e.file))}
                {groups.unstaged.length > 0
                  ? sectionHeader(
                      'Changes',
                      groups.unstaged.length,
                      <View style={styles.sectionActions}>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Stage all"
                          onPress={onStageAll}
                          style={styles.sectionAction}
                        >
                          <Text
                            style={{ color: theme.colors.accent, fontSize: 12, fontWeight: '600' }}
                          >
                            Stage all
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Discard all"
                          onPress={onDiscardAll}
                          style={styles.sectionAction}
                        >
                          <Text
                            style={{ color: theme.colors.danger, fontSize: 12, fontWeight: '600' }}
                          >
                            Discard all
                          </Text>
                        </TouchableOpacity>
                      </View>,
                    )
                  : null}
                {entries
                  .filter((e) => e.mode === 'unstaged')
                  .map((e) => renderFileBlock(e.mode, e.path, e.file))}
              </>
            )}
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 48,
  },
  back: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { ...TEXT_METRICS },
  path: { flex: 1, fontFamily: 'monospace', marginRight: 16, ...TEXT_METRICS },
  statusLine: {
    fontFamily: 'monospace',
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scrollContent: { alignItems: 'stretch' },
  center: { padding: 24, alignItems: 'center' },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 16,
  },
  sectionActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionAction: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fileBlock: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 8,
  },
  fileHeaderMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 8,
  },
  filePath: { flex: 1, fontFamily: 'monospace', fontSize: 13 },
  fileStat: { fontFamily: 'monospace', fontSize: 12, marginLeft: 8 },
  actionButton: {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileBody: { minHeight: 80 },
});

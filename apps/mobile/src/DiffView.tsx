import Feather from '@expo/vector-icons/Feather';
import { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { DiffLines } from './DiffLines';
import {
  buildFileTree,
  type DiffSummary,
  displayDiff,
  groupSummary,
  isImagePath,
} from './diffModel';
import { FileTree } from './FileTree';
import { ImageDiff } from './ImageDiff';
import { SideBySideDiff } from './SideBySideDiff';
import type { GitLogEntry } from './useTetherApp';

const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;
// Side-by-side is only offered where two readable columns actually fit.
const SIDE_BY_SIDE_MIN_WIDTH = 900;

export function DiffView({
  summary,
  selectedPath,
  diffMode,
  diffText,
  diffTruncated,
  diffLoading,
  diffImage,
  onSelectFile,
  onDeselectFile,
  onBack,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onToggleHunk,
  onCommit,
  historyEntries,
  historyCommit,
  onLoadHistory,
  onSelectCommit,
  sideBySide,
  onToggleSideBySide,
}: {
  summary: DiffSummary;
  selectedPath: string | null;
  diffMode: 'staged' | 'unstaged' | null;
  diffText: string | null;
  diffTruncated: boolean;
  diffLoading: boolean;
  diffImage: { old: string | null; new: string | null } | null;
  onSelectFile: (path: string, mode?: 'staged' | 'unstaged') => void;
  onDeselectFile: () => void;
  onBack: () => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onDiscardFile: (path: string) => void;
  onToggleHunk: (path: string, hunkIndex: number, staged: boolean) => void;
  onCommit: (message: string) => Promise<boolean>;
  historyEntries: GitLogEntry[] | null;
  historyCommit: { entry: GitLogEntry; diff: string | null; truncated: boolean } | null;
  onLoadHistory: () => void;
  onSelectCommit: (entry: GitLogEntry | null) => void;
  sideBySide: boolean;
  onToggleSideBySide: () => void;
}) {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

  const groups = groupSummary(summary);
  const selectedFile = summary.files.find((file) => file.path === selectedPath) ?? null;
  const isImage = selectedFile ? selectedFile.binary && isImagePath(selectedFile.path) : false;
  const wideEnough = width >= SIDE_BY_SIDE_MIN_WIDTH;
  const splitView = sideBySide && wideEnough;

  const toggleDir = (dir: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  };

  const openHistory = () => {
    setTab('history');
    onLoadHistory();
  };

  const submitCommit = async () => {
    if (!commitMessage.trim() || committing) return;
    setCommitting(true);
    const ok = await onCommit(commitMessage.trim());
    setCommitting(false);
    if (ok) setCommitMessage('');
  };

  const viewingCommit = tab === 'history' && historyCommit !== null;
  const headerLabel = viewingCommit
    ? `${historyCommit.entry.shortSha} ${historyCommit.entry.subject}`
    : (selectedPath ?? 'Changes');
  const backTarget = viewingCommit
    ? () => onSelectCommit(null)
    : selectedPath
      ? onDeselectFile
      : onBack;

  const renderDiffBody = (text: string, truncated: boolean, path: string, hunks: boolean) => (
    <ScrollView style={styles.vertical} contentContainerStyle={styles.content}>
      {splitView ? (
        <SideBySideDiff diffText={displayDiff(text, truncated)} />
      ) : (
        <DiffLines
          diffText={displayDiff(text, truncated)}
          path={path}
          onHunkPress={
            hunks && diffMode && selectedPath
              ? (hunkIndex) => onToggleHunk(selectedPath, hunkIndex, diffMode === 'staged')
              : undefined
          }
          hunkActionLabel={diffMode === 'staged' ? 'Unstage' : 'Stage'}
        />
      )}
    </ScrollView>
  );

  const sectionHeader = (label: string, count: number) => (
    <Text style={[styles.sectionHeader, { color: theme.colors.textMuted }]}>
      {label} ({count})
    </Text>
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={
            viewingCommit
              ? 'Back to history'
              : selectedPath
                ? 'Back to changed files'
                : 'Back to terminal'
          }
          onPress={backTarget}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: theme.colors.accent }]}>Back</Text>
        </TouchableOpacity>
        <Text numberOfLines={1} style={[styles.path, { color: theme.colors.text }]}>
          {headerLabel}
        </Text>
        {(selectedPath || viewingCommit) && !isImage && wideEnough ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={sideBySide ? 'Unified view' : 'Side-by-side view'}
            onPress={onToggleSideBySide}
            style={styles.back}
          >
            <Feather
              name={sideBySide ? 'square' : 'columns'}
              size={16}
              color={theme.colors.accent}
            />
          </TouchableOpacity>
        ) : null}
      </View>

      {!selectedPath && !viewingCommit ? (
        <View style={[styles.tabs, { borderBottomColor: theme.colors.border }]}>
          {(['changes', 'history'] as const).map((t) => (
            <TouchableOpacity
              key={t}
              accessibilityRole="button"
              accessibilityState={{ selected: tab === t }}
              onPress={t === 'history' ? openHistory : () => setTab('changes')}
              style={[
                styles.tab,
                tab === t && { borderBottomColor: theme.colors.accent, borderBottomWidth: 2 },
              ]}
            >
              <Text
                style={{
                  color: tab === t ? theme.colors.accent : theme.colors.textMuted,
                  fontWeight: tab === t ? '600' : '400',
                }}
              >
                {t === 'changes' ? 'Working tree' : 'History'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      {selectedPath ? (
        diffLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : isImage ? (
          <ImageDiff
            oldUri={diffImage?.old ?? null}
            newUri={diffImage?.new ?? null}
            loading={false}
          />
        ) : (
          renderDiffBody(diffText ?? '', diffTruncated, selectedPath, true)
        )
      ) : viewingCommit ? (
        historyCommit.diff === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : (
          renderDiffBody(historyCommit.diff, historyCommit.truncated, '', false)
        )
      ) : tab === 'history' ? (
        historyEntries === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : historyEntries.length === 0 ? (
          <View style={styles.center}>
            <Text style={{ color: theme.colors.text }}>No commits</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            {historyEntries.map((entry) => (
              <TouchableOpacity
                key={entry.sha}
                accessibilityRole="button"
                style={[styles.commitRow, { borderBottomColor: theme.colors.border }]}
                onPress={() => onSelectCommit(entry)}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.commitSubject, { color: theme.colors.text }]}
                >
                  {entry.subject}
                </Text>
                <Text style={[styles.commitMeta, { color: theme.colors.textMuted }]}>
                  {entry.shortSha} · {entry.author} · {new Date(entry.date).toLocaleDateString()}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )
      ) : summary.files.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.text }}>No changes</Text>
        </View>
      ) : (
        <>
          <ScrollView contentContainerStyle={styles.content}>
            {groups.staged.length > 0 ? (
              <>
                {sectionHeader('Staged', groups.staged.length)}
                <FileTree
                  nodes={buildFileTree(groups.staged)}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={toggleDir}
                  onSelectFile={(path) => onSelectFile(path, 'staged')}
                  fileActions={[{ icon: 'minus', label: 'Unstage', onPress: onUnstageFile }]}
                />
              </>
            ) : null}
            {groups.unstaged.length > 0 ? (
              <>
                {sectionHeader('Changes', groups.unstaged.length)}
                <FileTree
                  nodes={buildFileTree(groups.unstaged)}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={toggleDir}
                  onSelectFile={(path) => onSelectFile(path, 'unstaged')}
                  fileActions={[
                    { icon: 'plus', label: 'Stage', onPress: onStageFile },
                    {
                      icon: 'trash-2',
                      label: 'Discard',
                      destructive: true,
                      onPress: onDiscardFile,
                    },
                  ]}
                />
              </>
            ) : null}
          </ScrollView>
          {groups.staged.length > 0 ? (
            <View style={[styles.commitBar, { borderTopColor: theme.colors.border }]}>
              <TextInput
                style={[
                  styles.commitInput,
                  {
                    color: theme.colors.text,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface,
                  },
                ]}
                placeholder="Commit message"
                placeholderTextColor={theme.colors.textFaint}
                value={commitMessage}
                onChangeText={setCommitMessage}
                editable={!committing}
                multiline
              />
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Commit staged changes"
                disabled={!commitMessage.trim() || committing}
                onPress={submitCommit}
                style={[
                  styles.commitButton,
                  {
                    backgroundColor: theme.colors.accent,
                    opacity: !commitMessage.trim() || committing ? 0.5 : 1,
                  },
                ]}
              >
                {committing ? (
                  <ActivityIndicator color={theme.colors.accentText} size="small" />
                ) : (
                  <Text style={[styles.commitButtonText, { color: theme.colors.accentText }]}>
                    Commit
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}
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
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  backText: { ...TEXT_METRICS },
  path: { flex: 1, fontFamily: 'monospace', marginRight: 16, ...TEXT_METRICS },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { paddingHorizontal: 16, paddingVertical: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  vertical: { flex: 1 },
  content: { padding: 16, alignItems: 'stretch' },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 4,
  },
  commitRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  commitSubject: { fontSize: 14 },
  commitMeta: { fontFamily: 'monospace', fontSize: 12 },
  commitBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  commitInput: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 96,
    fontSize: 14,
  },
  commitButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commitButtonText: { fontWeight: '600' },
});

import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState } from 'react';
import type { View as RNView } from 'react-native';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { CommitBox } from './CommitBox';
import { DiffFileBody } from './DiffFileBody';
import { buildFileTree, type DiffSummary, groupSummary, isImagePath } from './diffModel';
import { FileTree } from './FileTree';
import { GitTabBar } from './GitTabBar';
import { toggleSetMember } from './gitReviewModel';
import { HistoryList } from './HistoryList';
import { MIN_TOUCH_TARGET } from './interaction';
import type { GitLogEntry } from './useTetherApp';

const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;
const SIDE_BY_SIDE_MIN_WIDTH = 900;
const DRAWER_WIDTH_RATIO = 0.75;
const LEFT_COLUMN_RATIO = 1 / 3;

export function GitDrawer({
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
  const drawerRef = useRef<RNView | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

  const groups = groupSummary(summary);
  const selectedFile = summary.files.find((file) => file.path === selectedPath) ?? null;
  const isImage = selectedFile ? selectedFile.binary && isImagePath(selectedFile.path) : false;
  const wideEnough = width >= SIDE_BY_SIDE_MIN_WIDTH;
  const drawerWidth = Math.round(width * DRAWER_WIDTH_RATIO);
  const leftWidth = Math.round(drawerWidth * LEFT_COLUMN_RATIO);
  const viewingCommit = tab === 'history' && historyCommit !== null;

  const headerLabel = viewingCommit
    ? `${historyCommit.entry.shortSha} ${historyCommit.entry.subject}`
    : (selectedPath ?? 'Changes');

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const root = drawerRef.current as unknown as { contains?: (n: Node) => boolean } | null;
      const target = event.target as Node | null;
      if (root?.contains && target && !root.contains(target)) return;
      const el = event.target as HTMLElement | null;
      if (el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT') {
        el.blur();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (viewingCommit) onSelectCommit(null);
      else if (selectedPath) onDeselectFile();
      else onBack();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [viewingCommit, selectedPath, onBack, onDeselectFile, onSelectCommit]);

  const submitCommit = async () => {
    if (!commitMessage.trim() || committing) return;
    setCommitting(true);
    const ok = await onCommit(commitMessage.trim());
    setCommitting(false);
    if (ok) setCommitMessage('');
  };

  const sectionHeader = (label: string, count: number) => (
    <Text style={[styles.sectionHeader, { color: theme.colors.textMuted }]}>
      {label} ({count})
    </Text>
  );

  const rightPane = () => {
    if (viewingCommit) {
      return (
        <DiffFileBody
          loading={historyCommit.diff === null}
          path=""
          diffText={historyCommit.diff}
          truncated={historyCommit.truncated}
          sideBySide={sideBySide}
          wideEnough={wideEnough}
        />
      );
    }
    if (!selectedPath) {
      return (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.textMuted }}>Select a file</Text>
        </View>
      );
    }
    return (
      <DiffFileBody
        loading={diffLoading}
        path={selectedPath}
        diffText={diffText}
        truncated={diffTruncated}
        image={isImage ? (diffImage ?? { old: null, new: null }) : null}
        sideBySide={sideBySide}
        wideEnough={wideEnough}
        onHunkPress={
          diffMode
            ? (hunkIndex) => onToggleHunk(selectedPath, hunkIndex, diffMode === 'staged')
            : undefined
        }
        hunkActionLabel={diffMode === 'staged' ? 'Unstage' : 'Stage'}
      />
    );
  };

  return (
    <View
      ref={drawerRef}
      style={[
        styles.root,
        {
          width: drawerWidth,
          backgroundColor: theme.colors.background,
          borderLeftColor: theme.colors.border,
        },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Close git drawer"
          onPress={onBack}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: theme.colors.accent }]}>Close</Text>
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

      <GitTabBar
        tab={tab}
        onChanges={() => {
          setTab('changes');
          onSelectCommit(null);
        }}
        onHistory={() => {
          setTab('history');
          onLoadHistory();
        }}
      />

      <View style={styles.body}>
        <View style={[styles.left, { width: leftWidth, borderRightColor: theme.colors.border }]}>
          {tab === 'history' ? (
            <HistoryList entries={historyEntries} onSelect={onSelectCommit} />
          ) : summary.files.length === 0 ? (
            <View style={styles.center}>
              <Text style={{ color: theme.colors.text }}>No changes</Text>
            </View>
          ) : (
            <>
              <ScrollView contentContainerStyle={styles.listContent}>
                {groups.staged.length > 0 ? (
                  <>
                    {sectionHeader('Staged', groups.staged.length)}
                    <FileTree
                      nodes={buildFileTree(groups.staged)}
                      collapsedDirs={collapsedDirs}
                      onToggleDir={(dir) => setCollapsedDirs((prev) => toggleSetMember(prev, dir))}
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
                      onToggleDir={(dir) => setCollapsedDirs((prev) => toggleSetMember(prev, dir))}
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
              <CommitBox
                message={commitMessage}
                onChangeMessage={setCommitMessage}
                onCommit={() => void submitCommit()}
                stagedCount={groups.staged.length}
                committing={committing}
              />
            </>
          )}
        </View>
        <View style={styles.right}>{rightPane()}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 48,
  },
  back: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { ...TEXT_METRICS },
  path: { flex: 1, fontFamily: 'monospace', marginRight: 16, ...TEXT_METRICS },
  body: { flex: 1, flexDirection: 'row' },
  left: {
    borderRightWidth: StyleSheet.hairlineWidth,
    flexDirection: 'column',
  },
  right: { flex: 1 },
  listContent: { padding: 12, alignItems: 'stretch' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 4,
  },
});

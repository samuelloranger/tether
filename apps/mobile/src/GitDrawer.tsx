import Feather from '@expo/vector-icons/Feather';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent, View as RNView } from 'react-native';
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
import {
  clampGitDrawerLeftWidth,
  defaultGitDrawerLeftWidth,
  drawerEscapeAction,
} from './gitDrawerLayout';
import { toggleSetMember } from './gitReviewModel';
import {
  canPushHead,
  canRewriteHead,
  formatRepoStatusLabel,
  type RepoStatus,
} from './gitStatusModel';
import { HistoryList } from './HistoryList';
import { MIN_TOUCH_TARGET } from './interaction';
import type { GitLogEntry } from './useTetherApp';

const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;
const SIDE_BY_SIDE_MIN_WIDTH = 900;

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
  onAmend,
  onUndoCommit,
  onPush,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
  onOpenLine,
  repoStatus,
  leftWidthStorageKey,
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
  onAmend: (message: string) => Promise<boolean>;
  onUndoCommit: () => void;
  onPush: () => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardAll: () => void;
  onOpenLine: (path: string, line: number) => void;
  repoStatus: RepoStatus;
  leftWidthStorageKey: string;
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
  const [bodyWidth, setBodyWidth] = useState(0);
  const [leftWidth, setLeftWidth] = useState<number | null>(null);
  const leftWidthRef = useRef<number | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  leftWidthRef.current = leftWidth;

  const groups = groupSummary(summary);
  const selectedFile = summary.files.find((file) => file.path === selectedPath) ?? null;
  const isImage = selectedFile ? selectedFile.binary && isImagePath(selectedFile.path) : false;
  const wideEnough = width >= SIDE_BY_SIDE_MIN_WIDTH;
  const viewingCommit = tab === 'history' && historyCommit !== null;
  const statusLabel = formatRepoStatusLabel(repoStatus);
  const canAmend = canRewriteHead(repoStatus);
  const canPush = canPushHead(repoStatus);
  const resolvedLeft =
    bodyWidth > 0
      ? leftWidth !== null
        ? clampGitDrawerLeftWidth(leftWidth, bodyWidth)
        : defaultGitDrawerLeftWidth(bodyWidth)
      : null;

  const headerLabel = viewingCommit
    ? `${historyCommit.entry.shortSha} ${historyCommit.entry.subject}`
    : (selectedPath ?? 'Changes');

  useEffect(() => {
    void AsyncStorage.getItem(leftWidthStorageKey).then((raw) => {
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) setLeftWidth(n);
    });
  }, [leftWidthStorageKey]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const root = drawerRef.current as unknown as { contains?: (n: Node) => boolean } | null;
      const target = event.target as Node | null;
      const el = event.target as HTMLElement | null;
      const inDrawer = Boolean(root?.contains && target && root.contains(target));
      const isTextField = el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT';
      const isDocumentRoot = target === document.body || target === document.documentElement;
      const action = drawerEscapeAction({ inDrawer, isTextField, isDocumentRoot });
      if (action === 'ignore') return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'blur-field') {
        el?.blur();
        return;
      }
      if (viewingCommit) onSelectCommit(null);
      else if (selectedPath) onDeselectFile();
      else onBack();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [viewingCommit, selectedPath, onBack, onDeselectFile, onSelectCommit]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || bodyWidth <= 0) return;
      setLeftWidth(
        clampGitDrawerLeftWidth(drag.startWidth + (event.clientX - drag.startX), bodyWidth),
      );
    };
    const onUp = () => {
      const wasDragging = dragRef.current !== null;
      dragRef.current = null;
      if (typeof document !== 'undefined' && document.body?.style) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
      const widthNow = leftWidthRef.current;
      if (wasDragging && bodyWidth > 0 && widthNow !== null) {
        const clamped = clampGitDrawerLeftWidth(widthNow, bodyWidth);
        void AsyncStorage.setItem(leftWidthStorageKey, String(clamped));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [bodyWidth, leftWidthStorageKey]);

  const onBodyLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setBodyWidth(next);
    setLeftWidth((prev) => (prev === null ? prev : clampGitDrawerLeftWidth(prev, next)));
  };

  const startResize = (clientX: number) => {
    if (bodyWidth <= 0) return;
    const current = resolvedLeft ?? defaultGitDrawerLeftWidth(bodyWidth);
    dragRef.current = { startX: clientX, startWidth: current };
    if (typeof document !== 'undefined' && document.body?.style) {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
  };

  const onSplitterGrant = (event: GestureResponderEvent) => {
    const native = event.nativeEvent as GestureResponderEvent['nativeEvent'] & {
      clientX?: number;
      pageX?: number;
    };
    const clientX = native.clientX ?? native.pageX;
    if (typeof clientX === 'number') startResize(clientX);
  };

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

  const sectionHeader = (label: string, count: number, actions?: ReactNode) => (
    <View style={styles.sectionHeaderRow}>
      <Text style={[styles.sectionHeader, { color: theme.colors.textMuted }]}>
        {label} ({count})
      </Text>
      {actions}
    </View>
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
        onOpenLine={(line) => onOpenLine(selectedPath, line)}
      />
    );
  };

  return (
    <View
      ref={drawerRef}
      style={[
        styles.root,
        {
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
        <View style={styles.headerTitles}>
          <Text numberOfLines={1} style={[styles.path, { color: theme.colors.text }]}>
            {headerLabel}
          </Text>
          {statusLabel && !viewingCommit ? (
            <Text numberOfLines={1} style={[styles.status, { color: theme.colors.textMuted }]}>
              {statusLabel}
            </Text>
          ) : null}
        </View>
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

      <View style={styles.body} onLayout={onBodyLayout}>
        <View
          style={[
            styles.left,
            resolvedLeft !== null ? { width: resolvedLeft } : styles.leftFallback,
          ]}
        >
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
                    {sectionHeader(
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
                    )}
                    <FileTree
                      nodes={buildFileTree(groups.staged)}
                      collapseScope="staged"
                      collapsedDirs={collapsedDirs}
                      onToggleDir={(key) => setCollapsedDirs((prev) => toggleSetMember(prev, key))}
                      onSelectFile={(path) => onSelectFile(path, 'staged')}
                      fileActions={[{ icon: 'minus', label: 'Unstage', onPress: onUnstageFile }]}
                    />
                  </>
                ) : null}
                {groups.unstaged.length > 0 ? (
                  <>
                    {sectionHeader(
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
                    )}
                    <FileTree
                      nodes={buildFileTree(groups.unstaged)}
                      collapseScope="unstaged"
                      collapsedDirs={collapsedDirs}
                      onToggleDir={(key) => setCollapsedDirs((prev) => toggleSetMember(prev, key))}
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
                onAmend={() => void submitAmend()}
                onUndoCommit={onUndoCommit}
                onPush={onPush}
                canAmend={canAmend}
                canPush={canPush}
                stagedCount={groups.staged.length}
                committing={committing}
              />
            </>
          )}
        </View>
        <View
          accessibilityRole="adjustable"
          accessibilityLabel="Resize file list"
          hitSlop={{ left: 4, right: 4, top: 0, bottom: 0 }}
          onStartShouldSetResponder={() => true}
          onResponderGrant={onSplitterGrant}
          {...({
            onPointerDown: (event: { clientX: number }) => startResize(event.clientX),
          } as object)}
          style={[styles.splitterHit, { cursor: 'col-resize' } as object]}
        >
          <View style={[styles.splitterLine, { backgroundColor: theme.colors.border }]} />
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
    left: 0,
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
  path: { flex: 1, fontFamily: 'monospace', ...TEXT_METRICS },
  headerTitles: { flex: 1, marginRight: 16, minWidth: 0 },
  status: { fontFamily: 'monospace', fontSize: 12, marginTop: 2 },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  sectionActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionAction: { minHeight: 28, justifyContent: 'center' },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  body: { flex: 1, flexDirection: 'row' },
  left: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'column',
    overflow: 'visible',
    zIndex: 3,
  },
  leftFallback: { flex: 1 },
  splitterHit: {
    width: 8,
    marginLeft: -3,
    marginRight: -3,
    zIndex: 2,
    alignItems: 'center',
  },
  splitterLine: {
    width: StyleSheet.hairlineWidth,
    flex: 1,
  },
  right: { flex: 1, minWidth: 0 },
  listContent: { padding: 12, alignItems: 'stretch' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
});

import Feather from '@expo/vector-icons/Feather';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { AppColors, AppTheme } from './appTheme';
import { DiffFileBody } from './DiffFileBody';
import type { DiffFileStat } from './diffModel';
import { isImagePath } from './diffModel';
import type { ReviewDiffSlot } from './fetchReviewDiff';
import { reviewDiffKey, toggleSetMember } from './gitReviewModel';
import { minTouchTarget } from './interaction';

const TOUCH_TARGET = minTouchTarget();

export type ReviewFileBlockProps = {
  mode: 'staged' | 'unstaged';
  path: string;
  file: DiffFileStat;
  theme: AppTheme;
  expanded: Set<string>;
  setExpanded: (update: (prev: Set<string>) => Set<string>) => void;
  reviewDiffs: Record<string, ReviewDiffSlot>;
  onUnstageFile: (path: string) => void;
  onStageFile: (path: string) => void;
  onDiscardFile: (path: string) => void;
  onToggleHunk: (path: string, hunkIndex: number, staged: boolean) => void;
  onRetryReviewDiff: (mode: 'staged' | 'unstaged', path: string) => void;
  onOpenLine: (path: string, line: number) => void;
};

function FileStats({ file, colors }: { file: DiffFileStat; colors: AppColors }) {
  if (file.binary) {
    return <Text style={[styles.fileStat, { color: colors.textMuted }]}>binary</Text>;
  }
  return (
    <Text style={styles.fileStat}>
      <Text style={{ color: colors.success }}>+{file.insertions}</Text>{' '}
      <Text style={{ color: colors.danger }}>-{file.deletions}</Text>
    </Text>
  );
}

function FileModeActions({
  mode,
  path,
  colors,
  onUnstageFile,
  onStageFile,
  onDiscardFile,
}: {
  mode: 'staged' | 'unstaged';
  path: string;
  colors: AppColors;
  onUnstageFile: (path: string) => void;
  onStageFile: (path: string) => void;
  onDiscardFile: (path: string) => void;
}) {
  if (mode === 'staged') {
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Unstage ${path}`}
        style={styles.actionButton}
        onPress={() => onUnstageFile(path)}
      >
        <Feather name="minus" size={15} color={colors.accent} />
      </TouchableOpacity>
    );
  }
  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Stage ${path}`}
        style={styles.actionButton}
        onPress={() => onStageFile(path)}
      >
        <Feather name="plus" size={15} color={colors.accent} />
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Discard ${path}`}
        style={styles.actionButton}
        onPress={() => onDiscardFile(path)}
      >
        <Feather name="trash-2" size={15} color={colors.danger} />
      </TouchableOpacity>
    </>
  );
}

function reviewImage(slot: ReviewDiffSlot | undefined, file: DiffFileStat, path: string) {
  if (slot?.status === 'image') return { old: slot.old, new: slot.new };
  if (file.binary && isImagePath(path)) return { old: null, new: null };
  return null;
}

export function ReviewFileBlock(p: ReviewFileBlockProps) {
  const key = reviewDiffKey(p.mode, p.path);
  const isExpanded = p.expanded.has(key);
  const slot = p.reviewDiffs[key];
  const colors = p.theme.colors;
  return (
    <View style={[styles.fileBlock, { borderBottomColor: colors.border }]}>
      <View style={styles.fileHeader}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`${isExpanded ? 'Collapse' : 'Expand'} file ${p.path}`}
          style={styles.fileHeaderMain}
          onPress={() => p.setExpanded((prev) => toggleSetMember(prev, key))}
        >
          <Feather
            name={isExpanded ? 'chevron-down' : 'chevron-right'}
            size={16}
            color={colors.textMuted}
          />
          <Text numberOfLines={1} style={[styles.filePath, { color: colors.text }]}>
            {p.path}
          </Text>
          <FileStats file={p.file} colors={colors} />
        </TouchableOpacity>
        <FileModeActions
          mode={p.mode}
          path={p.path}
          colors={colors}
          onUnstageFile={p.onUnstageFile}
          onStageFile={p.onStageFile}
          onDiscardFile={p.onDiscardFile}
        />
      </View>
      {isExpanded ? (
        <View style={styles.fileBody}>
          <DiffFileBody
            loading={!slot || slot.status === 'loading'}
            error={slot?.status === 'error' ? slot.message : null}
            path={p.path}
            diffText={slot?.status === 'ready' ? slot.text : null}
            truncated={slot?.status === 'ready' ? slot.truncated : false}
            image={reviewImage(slot, p.file, p.path)}
            sideBySide={false}
            wideEnough={false}
            scrollable={false}
            onHunkPress={(hunkIndex) => p.onToggleHunk(p.path, hunkIndex, p.mode === 'staged')}
            hunkActionLabel={p.mode === 'staged' ? 'Unstage' : 'Stage'}
            onRetry={() => p.onRetryReviewDiff(p.mode, p.path)}
            onOpenLine={(line) => p.onOpenLine(p.path, line)}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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

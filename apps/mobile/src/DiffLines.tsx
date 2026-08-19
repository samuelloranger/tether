import { Prism } from 'prism-react-renderer';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppTheme } from './appTheme';
import { colorForTokenTypes } from './CodeHighlight';
import { languageForPath, tokenizeLine } from './codeLanguage';
import { type DiffLine, parseDiffLines } from './diffModel';
import { minTouchTarget } from './interaction';

type Grammar = Parameters<typeof tokenizeLine>[1];

const TOUCH_TARGET = minTouchTarget();
const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;

type DiffLinesProps = {
  diffText: string;
  path: string;
  onHunkPress?: (hunkIndex: number) => void;
  hunkActionLabel?: string;
  onOpenLine?: (line: number) => void;
};

function DiffHunkRow({
  theme,
  hunkContext,
  hunkIndex,
  onHunkPress,
  hunkActionLabel,
}: {
  theme: AppTheme;
  hunkContext: string;
  hunkIndex: number;
  onHunkPress?: (hunkIndex: number) => void;
  hunkActionLabel?: string;
}) {
  return (
    <View style={[styles.hunkRow, { borderTopColor: theme.colors.border }]}>
      <Text style={[styles.hunkLabel, { color: theme.colors.textFaint }]}>⋯</Text>
      {hunkContext ? (
        <Text numberOfLines={1} style={[styles.hunkContext, { color: theme.colors.textFaint }]}>
          {hunkContext}
        </Text>
      ) : null}
      {onHunkPress ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`${hunkActionLabel ?? 'Stage'} hunk ${hunkIndex + 1}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={() => onHunkPress(hunkIndex)}
          style={styles.hunkActionHit}
        >
          <Text style={[styles.hunkAction, { color: theme.colors.accent }]}>
            {hunkActionLabel ?? 'Stage'}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function DiffLineContent({
  theme,
  line,
  numberWidth,
  grammar,
  onOpenLine,
}: {
  theme: AppTheme;
  line: DiffLine;
  numberWidth: number;
  grammar: Grammar;
  onOpenLine?: (line: number) => void;
}) {
  const tokens = tokenizeLine(line.content, grammar);
  return (
    <>
      <Text
        style={[
          styles.gutterNum,
          TEXT_METRICS,
          { width: numberWidth, color: theme.colors.textFaint },
        ]}
      >
        {line.oldLine ?? ''}
      </Text>
      <Text
        style={[
          styles.gutterNum,
          TEXT_METRICS,
          { width: numberWidth, color: theme.colors.textFaint },
        ]}
      >
        {line.newLine ?? ''}
      </Text>
      <Text
        style={[
          styles.marker,
          TEXT_METRICS,
          {
            color:
              line.kind === 'add'
                ? theme.colors.success
                : line.kind === 'remove'
                  ? theme.colors.danger
                  : theme.colors.textFaint,
          },
        ]}
      >
        {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
      </Text>
      <Text
        selectable={!onOpenLine}
        style={[styles.content, TEXT_METRICS, { color: theme.terminal.fg }]}
      >
        {tokens
          ? tokens.map((token, tokenIndex) => (
              <Text
                key={tokenIndex}
                style={{ color: colorForTokenTypes(token.types, theme.colors) }}
              >
                {token.content}
              </Text>
            ))
          : line.content}
      </Text>
    </>
  );
}

function DiffContentRow({
  theme,
  path,
  line,
  numberWidth,
  grammar,
  onOpenLine,
}: {
  theme: AppTheme;
  path: string;
  line: DiffLine;
  numberWidth: number;
  grammar: Grammar;
  onOpenLine?: (n: number) => void;
}) {
  const rowBg =
    line.kind === 'add'
      ? `${theme.colors.success}18`
      : line.kind === 'remove'
        ? `${theme.colors.danger}18`
        : undefined;
  const openLine = line.newLine ?? line.oldLine;
  const content = (
    <DiffLineContent
      theme={theme}
      line={line}
      numberWidth={numberWidth}
      grammar={grammar}
      onOpenLine={onOpenLine}
    />
  );
  if (onOpenLine && openLine != null) {
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Open ${path} at line ${openLine}`}
        onPress={() => onOpenLine(openLine)}
        style={[styles.row, rowBg ? { backgroundColor: rowBg } : null]}
      >
        {content}
      </TouchableOpacity>
    );
  }
  return <View style={[styles.row, rowBg ? { backgroundColor: rowBg } : null]}>{content}</View>;
}

export function DiffLines({
  diffText,
  path,
  onHunkPress,
  hunkActionLabel,
  onOpenLine,
}: DiffLinesProps) {
  const { theme } = useAppTheme();
  const language = languageForPath(path);
  const grammar = language ? Prism.languages[language] : undefined;
  const lines = parseDiffLines(diffText).filter(
    (line) => line.kind !== 'meta' || HUNK_HEADER.test(line.text),
  );
  const maxLineNumber = lines.reduce(
    (max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0),
    1,
  );
  const numberWidth = String(maxLineNumber).length * 8 + 4;
  let hunkIndex = -1;
  return (
    <View style={styles.root}>
      {lines.map((line, index) => {
        const hunkContext = line.kind === 'meta' ? line.text.match(HUNK_HEADER)?.[1] : undefined;
        if (hunkContext !== undefined) {
          hunkIndex++;
          return (
            <DiffHunkRow
              key={index}
              theme={theme}
              hunkContext={hunkContext}
              hunkIndex={hunkIndex}
              onHunkPress={onHunkPress}
              hunkActionLabel={hunkActionLabel}
            />
          );
        }
        return (
          <DiffContentRow
            key={index}
            theme={theme}
            path={path}
            line={line}
            numberWidth={numberWidth}
            grammar={grammar}
            onOpenLine={onOpenLine}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'stretch' },
  hunkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    marginVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  hunkLabel: { fontFamily: 'monospace', fontSize: 12 },
  hunkContext: { fontFamily: 'monospace', fontSize: 12, flexShrink: 1 },
  hunkActionHit: {
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hunkAction: { fontSize: 12, fontWeight: '600', paddingHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  gutterNum: { fontFamily: 'monospace', fontSize: 14, textAlign: 'right', marginRight: 8 },
  marker: { fontFamily: 'monospace', fontSize: 14, width: 12 },
  content: { fontFamily: 'monospace', fontSize: 14, flexShrink: 1, flex: 1 },
});

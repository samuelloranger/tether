import { Prism } from 'prism-react-renderer';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { colorForTokenTypes } from './CodeHighlight';
import { languageForPath, tokenizeLine } from './codeLanguage';
import { parseDiffLines } from './diffModel';

const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;

// Renders a unified diff with an old/new line-number gutter and per-line
// syntax highlighting. Tokenizes each content line independently (rather
// than the whole diff blob at once) so hunk gaps and interleaved +/- markup
// never corrupt the grammar — see CodeHighlight's `path` doc comment for why
// that matters.
export function DiffLines({
  diffText,
  path,
  onHunkPress,
  hunkActionLabel,
}: {
  diffText: string;
  path: string;
  // Stage/unstage affordance on each hunk header. The index passed is the
  // ordinal over @@ headers — the same numbering the server's hunk endpoints
  // consume (its splitHunks counts identically).
  onHunkPress?: (hunkIndex: number) => void;
  hunkActionLabel?: string;
}) {
  const { theme } = useAppTheme();
  const language = languageForPath(path);
  const grammar = language ? Prism.languages[language] : undefined;
  // Drop the pure-boilerplate git plumbing lines (diff --git/index/---/+++)
  // — the file path is already the screen's header. Hunk headers (@@ ... @@)
  // carry real information (lines were skipped here) so they stay, rendered
  // as a divider instead of raw diff syntax.
  const lines = parseDiffLines(diffText).filter(
    (line) => line.kind !== 'meta' || HUNK_HEADER.test(line.text),
  );
  const maxLineNumber = lines.reduce(
    (max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0),
    1,
  );
  const numberWidth = String(maxLineNumber).length * 8 + 4;

  // Ordinal over the hunk headers that survive the filter above — identical to
  // the unfiltered ordinal since only non-hunk meta lines were dropped.
  let hunkIndex = -1;
  return (
    <View style={styles.root}>
      {lines.map((line, index) => {
        const hunkContext = line.kind === 'meta' ? line.text.match(HUNK_HEADER)?.[1] : undefined;
        if (hunkContext !== undefined) {
          hunkIndex++;
          const thisHunk = hunkIndex;
          return (
            <View key={index} style={[styles.hunkRow, { borderTopColor: theme.colors.border }]}>
              <Text style={[styles.hunkLabel, { color: theme.colors.textFaint }]}>⋯</Text>
              {hunkContext ? (
                <Text
                  numberOfLines={1}
                  style={[styles.hunkContext, { color: theme.colors.textFaint }]}
                >
                  {hunkContext}
                </Text>
              ) : null}
              {onHunkPress ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`${hunkActionLabel ?? 'Stage'} hunk ${thisHunk + 1}`}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => onHunkPress(thisHunk)}
                >
                  <Text style={[styles.hunkAction, { color: theme.colors.accent }]}>
                    {hunkActionLabel ?? 'Stage'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        }
        const rowBg =
          line.kind === 'add'
            ? `${theme.colors.success}18`
            : line.kind === 'remove'
              ? `${theme.colors.danger}18`
              : undefined;
        const markerColor =
          line.kind === 'add'
            ? theme.colors.success
            : line.kind === 'remove'
              ? theme.colors.danger
              : theme.colors.textFaint;
        const tokens = tokenizeLine(line.content, grammar);
        return (
          <View key={index} style={[styles.row, rowBg ? { backgroundColor: rowBg } : null]}>
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
            <Text style={[styles.marker, TEXT_METRICS, { color: markerColor }]}>
              {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
            </Text>
            <Text selectable style={[styles.content, TEXT_METRICS, { color: theme.terminal.fg }]}>
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
          </View>
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
  hunkAction: { fontSize: 12, fontWeight: '600', paddingHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  gutterNum: { fontFamily: 'monospace', fontSize: 14, textAlign: 'right', marginRight: 8 },
  marker: { fontFamily: 'monospace', fontSize: 14, width: 12 },
  content: { fontFamily: 'monospace', fontSize: 14, flexShrink: 1, flex: 1 },
});

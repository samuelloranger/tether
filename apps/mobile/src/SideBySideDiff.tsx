import { Prism } from 'prism-react-renderer';
import { StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { colorForTokenTypes } from './CodeHighlight';
import { languageForPath, tokenizeLine } from './codeLanguage';
import { type DiffLine, pairDiffRows, parseDiffLines } from './diffModel';

const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;

// Split (two-column) rendering of a unified diff for wide panes: removed lines
// on the left, added lines on the right, aligned within each change block.
// Unified DiffLines stays the default; this is a width-gated alternative.
export function SideBySideDiff({ diffText, path }: { diffText: string; path: string }) {
  const { theme } = useAppTheme();
  const language = languageForPath(path);
  const grammar = language ? Prism.languages[language] : undefined;
  const lines = parseDiffLines(diffText).filter(
    (line) => line.kind !== 'meta' || HUNK_HEADER.test(line.text),
  );
  const rows = pairDiffRows(lines);

  const cell = (line: DiffLine | null, side: 'left' | 'right') => {
    const bg =
      line?.kind === 'remove'
        ? `${theme.colors.danger}18`
        : line?.kind === 'add'
          ? `${theme.colors.success}18`
          : undefined;
    const lineNumber = side === 'left' ? line?.oldLine : line?.newLine;
    const tokens = line ? tokenizeLine(line.content, grammar) : null;
    return (
      <View style={[styles.cell, bg ? { backgroundColor: bg } : null]}>
        <Text style={[styles.gutterNum, TEXT_METRICS, { color: theme.colors.textFaint }]}>
          {lineNumber ?? ''}
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
            : (line?.content ?? '')}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      {rows.map((row, index) =>
        row.span ? (
          <View
            key={index}
            style={[styles.hunkRow, { borderTopColor: theme.colors.border }]}
          >
            <Text style={[styles.hunkLabel, { color: theme.colors.textFaint }]}>
              ⋯ {row.left?.text.match(HUNK_HEADER)?.[1] ?? ''}
            </Text>
          </View>
        ) : (
          <View key={index} style={styles.row}>
            {cell(row.left, 'left')}
            <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
            {cell(row.right, 'right')}
          </View>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  cell: { flex: 1, flexDirection: 'row', alignItems: 'flex-start' },
  divider: { width: StyleSheet.hairlineWidth },
  gutterNum: {
    fontFamily: 'monospace',
    fontSize: 14,
    textAlign: 'right',
    width: 40,
    marginRight: 8,
  },
  content: { fontFamily: 'monospace', fontSize: 14, flexShrink: 1, flex: 1 },
  hunkRow: {
    paddingVertical: 6,
    marginVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  hunkLabel: { fontFamily: 'monospace', fontSize: 12 },
});

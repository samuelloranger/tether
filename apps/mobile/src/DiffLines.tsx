import { StyleSheet, Text, View } from 'react-native';
import { normalizeTokens, Prism } from 'prism-react-renderer';
import { useAppTheme } from './AppThemeProvider';
import { colorForTokenTypes } from './CodeHighlight';
import { languageForPath } from './codeLanguage';
import { parseDiffLines } from './diffModel';

const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;

// Renders a unified diff with an old/new line-number gutter and per-line
// syntax highlighting. Tokenizes each content line independently (rather
// than the whole diff blob at once) so hunk gaps and interleaved +/- markup
// never corrupt the grammar — see CodeHighlight's `path` doc comment for why
// that matters.
export function DiffLines({ diffText, path }: { diffText: string; path: string }) {
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

  return (
    <View style={styles.root}>
      {lines.map((line, index) => {
        const hunkContext = line.kind === 'meta' ? line.text.match(HUNK_HEADER)?.[1] : undefined;
        if (hunkContext !== undefined) {
          return (
            <View key={index} style={[styles.hunkRow, { borderTopColor: theme.colors.border }]}>
              <Text style={[styles.hunkLabel, { color: theme.colors.textFaint }]}>⋯</Text>
              {hunkContext ? (
                <Text numberOfLines={1} style={[styles.hunkContext, { color: theme.colors.textFaint }]}>
                  {hunkContext}
                </Text>
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
        const tokens = grammar ? (normalizeTokens(Prism.tokenize(line.content, grammar))[0] ?? []) : null;
        return (
          <View key={index} style={[styles.row, rowBg ? { backgroundColor: rowBg } : null]}>
            <Text
              style={[styles.gutterNum, TEXT_METRICS, { width: numberWidth, color: theme.colors.textFaint }]}
            >
              {line.oldLine ?? ''}
            </Text>
            <Text
              style={[styles.gutterNum, TEXT_METRICS, { width: numberWidth, color: theme.colors.textFaint }]}
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
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  gutterNum: { fontFamily: 'monospace', fontSize: 14, textAlign: 'right', marginRight: 8 },
  marker: { fontFamily: 'monospace', fontSize: 14, width: 12 },
  content: { fontFamily: 'monospace', fontSize: 14, flexShrink: 1, flex: 1 },
});

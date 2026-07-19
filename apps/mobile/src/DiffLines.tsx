import { StyleSheet, Text, View } from 'react-native';
import { normalizeTokens, Prism } from 'prism-react-renderer';
import { useAppTheme } from './AppThemeProvider';
import { colorForTokenTypes } from './CodeHighlight';
import { languageForPath } from './codeLanguage';
import { parseDiffLines } from './diffModel';

const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;

// Renders a unified diff with an old/new line-number gutter and per-line
// syntax highlighting. Tokenizes each content line independently (rather
// than the whole diff blob at once) so hunk gaps and interleaved +/- markup
// never corrupt the grammar — see CodeHighlight's `path` doc comment for why
// that matters.
export function DiffLines({ diffText, path }: { diffText: string; path: string }) {
  const { theme } = useAppTheme();
  const language = languageForPath(path);
  const grammar = language ? Prism.languages[language] : undefined;
  const lines = parseDiffLines(diffText);
  const maxLineNumber = lines.reduce(
    (max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0),
    1,
  );
  const numberWidth = String(maxLineNumber).length * 8 + 4;

  return (
    <View style={styles.root}>
      {lines.map((line, index) => {
        if (line.kind === 'meta') {
          return (
            <Text
              key={index}
              style={[
                styles.metaLine,
                TEXT_METRICS,
                { color: theme.colors.textMuted, backgroundColor: theme.colors.surfaceRaised },
              ]}
            >
              {line.text}
            </Text>
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
  metaLine: { fontFamily: 'monospace', fontSize: 14, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  gutterNum: { fontFamily: 'monospace', fontSize: 14, textAlign: 'right', marginRight: 8 },
  marker: { fontFamily: 'monospace', fontSize: 14, width: 12 },
  content: { fontFamily: 'monospace', fontSize: 14, flexShrink: 1, flex: 1 },
});

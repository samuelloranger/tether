import { Text, type TextStyle } from 'react-native';
import { Highlight, Prism, type PrismTheme } from 'prism-react-renderer';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { languageForPath } from './codeLanguage';

export function CodeHighlight({
  path,
  code,
  lineStyle,
  onLineLayout,
}: {
  // Omit for content that isn't source in a single language — a unified diff
  // mixes hunk headers/+-/- markers with the target file's syntax, and running
  // it through that file's grammar corrupts tokenization (e.g. "diff --git a/x
  // b/x" parses "--" as an operator, merging tokens across the line break).
  path?: string;
  code: string;
  lineStyle?: (line: string, index: number) => TextStyle | undefined;
  onLineLayout?: (index: number, y: number) => void;
}) {
  const { theme } = useAppTheme();
  const language = path ? languageForPath(path) : null;
  const baseStyle: TextStyle = {
    color: theme.terminal.fg,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 20,
    minHeight: 20,
    flexShrink: 1,
    width: '100%',
  };
  const sourceLines = code.split('\n');

  if (!language || !Prism.languages[language]) {
    return sourceLines.map((line, index) => (
      <Text
        key={index}
        selectable
        style={[baseStyle, lineStyle?.(line, index)]}
        onLayout={(event) => onLineLayout?.(index, event.nativeEvent.layout.y)}
      >
        {line}
      </Text>
    ));
  }

  return (
    <Highlight theme={prismTheme(theme.colors, theme.terminal.fg)} code={code} language={language}>
      {({ tokens, getTokenProps }) => (
        <>
          {tokens.map((lineTokens, index) => (
            <Text
              key={index}
              selectable
              style={[baseStyle, lineStyle?.(sourceLines[index] ?? '', index)]}
              onLayout={(event) => onLineLayout?.(index, event.nativeEvent.layout.y)}
            >
              {lineTokens.map((token, tokenIndex) => {
                const props = getTokenProps({ token });
                return (
                  <Text key={tokenIndex} style={props.style as TextStyle}>
                    {props.children}
                  </Text>
                );
              })}
            </Text>
          ))}
        </>
      )}
    </Highlight>
  );
}

const TOKEN_STYLE_GROUPS: Array<{ types: string[]; colorKey: keyof AppColors }> = [
  { types: ['comment', 'prolog', 'doctype', 'cdata'], colorKey: 'textMuted' },
  { types: ['punctuation'], colorKey: 'text' },
  { types: ['property', 'tag', 'constant', 'symbol', 'deleted'], colorKey: 'danger' },
  { types: ['boolean', 'number'], colorKey: 'warning' },
  { types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'], colorKey: 'success' },
  { types: ['operator', 'entity', 'url'], colorKey: 'info' },
  { types: ['atrule', 'attr-value', 'keyword'], colorKey: 'accent' },
  { types: ['function', 'class-name'], colorKey: 'info' },
  { types: ['regex', 'important', 'variable'], colorKey: 'warning' },
];

// Shared with DiffLines, which tokenizes diff content line-by-line (rather
// than through this component's whole-blob <Highlight>) so it can skip diff
// markup lines without corrupting tokenization.
export function colorForTokenTypes(types: string[], colors: AppColors): string | undefined {
  for (const group of TOKEN_STYLE_GROUPS) {
    if (types.some((type) => group.types.includes(type))) return colors[group.colorKey];
  }
  return undefined;
}

function prismTheme(c: AppColors, foreground: string): PrismTheme {
  return {
    plain: { color: foreground },
    styles: TOKEN_STYLE_GROUPS.map((group) => ({
      types: group.types,
      style: { color: c[group.colorKey] },
    })),
  };
}

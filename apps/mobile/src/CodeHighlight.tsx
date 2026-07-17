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
  path: string;
  code: string;
  lineStyle?: (line: string, index: number) => TextStyle | undefined;
  onLineLayout?: (index: number, y: number) => void;
}) {
  const { theme } = useAppTheme();
  const language = languageForPath(path);
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

function prismTheme(c: AppColors, foreground: string): PrismTheme {
  return {
    plain: { color: foreground },
    styles: [
      { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: c.textMuted } },
      { types: ['punctuation'], style: { color: c.text } },
      { types: ['property', 'tag', 'constant', 'symbol', 'deleted'], style: { color: c.danger } },
      { types: ['boolean', 'number'], style: { color: c.warning } },
      { types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'], style: { color: c.success } },
      { types: ['operator', 'entity', 'url'], style: { color: c.info } },
      { types: ['atrule', 'attr-value', 'keyword'], style: { color: c.accent } },
      { types: ['function', 'class-name'], style: { color: c.info } },
      { types: ['regex', 'important', 'variable'], style: { color: c.warning } },
    ],
  };
}

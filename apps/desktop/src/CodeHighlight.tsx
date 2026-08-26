import { Highlight, type PrismTheme } from 'prism-react-renderer';
import { languageForPath } from './workspaceTypes';

type AppColors = {
  text: string;
  textMuted: string;
  danger: string;
  warning: string;
  success: string;
  info: string;
  accent: string;
};

const TOKEN_STYLE_GROUPS: Array<{ types: string[]; colorKey: keyof AppColors }> = [
  { types: ['comment', 'prolog', 'doctype', 'cdata'], colorKey: 'textMuted' },
  { types: ['punctuation'], colorKey: 'text' },
  { types: ['property', 'tag', 'constant', 'symbol', 'deleted'], colorKey: 'danger' },
  { types: ['boolean', 'number'], colorKey: 'warning' },
  {
    types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'],
    colorKey: 'success',
  },
  { types: ['operator', 'entity', 'url'], colorKey: 'info' },
  { types: ['atrule', 'attr-value', 'keyword'], colorKey: 'accent' },
  { types: ['function', 'class-name'], colorKey: 'info' },
  { types: ['regex', 'important', 'variable'], colorKey: 'warning' },
];

function prismTheme(colors: AppColors, foreground: string): PrismTheme {
  return {
    plain: { color: foreground },
    styles: TOKEN_STYLE_GROUPS.map((group) => ({
      types: group.types,
      style: { color: colors[group.colorKey] },
    })),
  };
}

export function CodeHighlight({
  path,
  code,
  colors,
  foreground,
}: {
  path?: string;
  code: string;
  colors: AppColors;
  foreground: string;
}) {
  const language = path ? languageForPath(path) : null;
  const sourceLines = code.split('\n');

  if (!language) {
    return (
      <pre className="code-highlight">
        {sourceLines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable line order for a static snapshot
          <div key={index} className="code-line">
            {line}
          </div>
        ))}
      </pre>
    );
  }

  return (
    <Highlight
      theme={prismTheme(colors, foreground)}
      code={code}
      language={language as 'typescript'}
    >
      {({ tokens, getTokenProps }) => (
        <pre className="code-highlight">
          {tokens.map((lineTokens, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable line order for a static snapshot
            <div key={index} className="code-line">
              {lineTokens.map((token, tokenIndex) => {
                const props = getTokenProps({ token });
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: token order within a line is fixed
                  <span key={tokenIndex} style={props.style}>
                    {props.children}
                  </span>
                );
              })}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

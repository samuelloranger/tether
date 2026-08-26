const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  html: 'markup',
  css: 'css',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  rs: 'rust',
  go: 'go',
};

export function languageForPath(path: string): string | null {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return LANGUAGES[extension] ?? null;
}

const KEYWORDS: Record<string, string[]> = {
  typescript: [
    'const',
    'let',
    'var',
    'function',
    'return',
    'import',
    'export',
    'from',
    'class',
    'interface',
    'type',
    'async',
    'await',
    'if',
    'else',
    'for',
    'while',
    'new',
    'true',
    'false',
    'null',
    'undefined',
  ],
  javascript: [
    'const',
    'let',
    'var',
    'function',
    'return',
    'import',
    'export',
    'from',
    'class',
    'async',
    'await',
    'if',
    'else',
    'for',
    'while',
    'new',
    'true',
    'false',
    'null',
    'undefined',
  ],
  python: [
    'def',
    'return',
    'import',
    'from',
    'class',
    'async',
    'await',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'True',
    'False',
    'None',
    'with',
    'as',
    'pass',
  ],
  rust: [
    'fn',
    'let',
    'mut',
    'pub',
    'struct',
    'enum',
    'impl',
    'use',
    'mod',
    'async',
    'await',
    'if',
    'else',
    'for',
    'while',
    'match',
    'return',
    'true',
    'false',
    'Self',
  ],
  go: [
    'func',
    'return',
    'import',
    'package',
    'type',
    'struct',
    'interface',
    'if',
    'else',
    'for',
    'range',
    'go',
    'defer',
    'true',
    'false',
    'nil',
  ],
};

export type HighlightToken = { text: string; className?: string };

/** Lightweight line highlighter — enough for diff review without Prism. */
export function highlightLine(content: string, language: string | null): HighlightToken[] {
  if (!language || !content) return [{ text: content }];
  const keywords = KEYWORDS[language] ?? KEYWORDS.typescript;
  const tokens: HighlightToken[] = [];
  const re =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|#.*|\b[A-Za-z_][\w']*\b|\d+\.?\d*|[^\s\w]+|\s+)/g;
  while (true) {
    const match = re.exec(content);
    if (!match) break;
    const text = match[0];
    if (/^["'`]/.test(text)) tokens.push({ text, className: 'tok-string' });
    else if (/^\/\/|^#/.test(text)) tokens.push({ text, className: 'tok-comment' });
    else if (/^\d/.test(text)) tokens.push({ text, className: 'tok-number' });
    else if (keywords.includes(text)) tokens.push({ text, className: 'tok-keyword' });
    else tokens.push({ text });
  }
  return tokens.length > 0 ? tokens : [{ text: content }];
}

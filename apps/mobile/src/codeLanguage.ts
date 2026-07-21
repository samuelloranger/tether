import { normalizeTokens, Prism } from 'prism-react-renderer';

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
};

export function languageForPath(path: string): string | null {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return LANGUAGES[extension] ?? null;
}

// One diff/code line tokenized independently, so surrounding lines (hunk
// gaps, +/- markers) never corrupt the grammar. Null when no grammar.
export function tokenizeLine(
  content: string,
  grammar: Prism.Grammar | undefined,
): ReturnType<typeof normalizeTokens>[number] | null {
  if (!grammar) return null;
  return normalizeTokens(Prism.tokenize(content, grammar))[0] ?? [];
}

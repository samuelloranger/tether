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

import { expect, test } from 'bun:test';
import { Prism } from 'prism-react-renderer';

import { languageForPath, tokenizeLine } from './codeLanguage';

test('languageForPath maps supported extensions and falls back to plain text', () => {
  expect(languageForPath('src/app.tsx')).toBe('tsx');
  expect(languageForPath('src/app.ts')).toBe('typescript');
  expect(languageForPath('scripts/install.sh')).toBe('bash');
  expect(languageForPath('README.md')).toBe('markdown');
  expect(languageForPath('config.yml')).toBe('yaml');
  expect(languageForPath('assets/blob.bin')).toBeNull();
});

test('tokenizeLine returns null without a grammar', () => {
  expect(tokenizeLine('const x = 1;', undefined)).toBeNull();
});

test('tokenizeLine tokenizes one line with a grammar', () => {
  const grammar = Prism.languages.typescript;
  const tokens = tokenizeLine('const x = 1;', grammar);
  expect(tokens).not.toBeNull();
  expect(tokens!.map((t) => t.content).join('')).toBe('const x = 1;');
  expect(tokens!.some((t) => t.types.includes('keyword'))).toBe(true);
});

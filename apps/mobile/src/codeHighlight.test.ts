import { expect, test } from 'bun:test';
import { languageForPath } from './codeLanguage';

test('languageForPath maps supported extensions and falls back to plain text', () => {
  expect(languageForPath('src/app.tsx')).toBe('tsx');
  expect(languageForPath('src/app.ts')).toBe('typescript');
  expect(languageForPath('scripts/install.sh')).toBe('bash');
  expect(languageForPath('README.md')).toBe('markdown');
  expect(languageForPath('config.yml')).toBe('yaml');
  expect(languageForPath('assets/blob.bin')).toBeNull();
});

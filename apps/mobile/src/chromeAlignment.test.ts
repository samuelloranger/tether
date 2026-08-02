import { expect, test } from 'bun:test';

const source = (name: string) => Bun.file(new URL(name, import.meta.url)).text();

test('compact desktop chrome pins the affected text metrics', async () => {
  const [titleBar, panelHeader, fileViewer, gitDrawer, gitReview] = await Promise.all([
    source('./TitleBar.tsx'),
    source('./PanelHeader.tsx'),
    source('./FileViewer.tsx'),
    source('./GitDrawer.tsx'),
    source('./GitReview.tsx'),
  ]);

  for (const name of ['title', 'subtitle', 'statusWordOk', 'statusWordWarn', 'statusWordOff']) {
    expect(titleBar).toMatch(new RegExp(`${name}: \\{[^}]*lineHeight: \\d+[^}]*COMPACT_TEXT`));
  }

  expect(panelHeader).toContain(
    'const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false }',
  );
  expect(panelHeader).toContain('style={[styles.backText,');
  expect(panelHeader).toMatch(/backText: \{[^}]*TEXT_METRICS/);
  expect(panelHeader).toMatch(/path: \{[^}]*TEXT_METRICS/);

  for (const viewer of [fileViewer, gitDrawer, gitReview]) {
    expect(viewer).toContain("from './PanelHeader'");
    expect(viewer).toContain('<PanelHeader');
  }
});

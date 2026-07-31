import { expect, test } from 'bun:test';

test('insets the mobile drawer content below the top safe area', async () => {
  const source = await Bun.file(new URL('./SessionDrawer.tsx', import.meta.url)).text();

  expect(source).toContain("<SafeAreaView edges={['top']} style={styles.panelContent}>");
});

test('uses a tight top inset for the wide-desktop overlay under the title bar', async () => {
  const source = await Bun.file(new URL('./SessionDrawer.tsx', import.meta.url)).text();

  expect(source).toContain('panelContentDesktop');
  expect(source).toContain('showPin ? (');
  expect(source).toMatch(/panelContentDesktop:\s*\{\s*paddingTop:\s*8\s*\}/);
});

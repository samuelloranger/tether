import { expect, test } from 'bun:test';

test('insets the mobile drawer content inside all safe-area edges', async () => {
  const source = await Bun.file(new URL('./SessionDrawer.tsx', import.meta.url)).text();

  expect(source).toContain(
    "<SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.panelContent}>",
  );
});

test('uses a tight top inset for the wide-desktop overlay under the title bar', async () => {
  const [drawer, styles] = await Promise.all([
    Bun.file(new URL('./SessionDrawer.tsx', import.meta.url)).text(),
    Bun.file(new URL('./sessionDrawerStyles.ts', import.meta.url)).text(),
  ]);

  expect(drawer).toContain('panelContentDesktop');
  expect(drawer).toContain('showPin ? (');
  expect(styles).toMatch(/panelContentDesktop:\s*\{\s*paddingTop:\s*8\s*\}/);
});

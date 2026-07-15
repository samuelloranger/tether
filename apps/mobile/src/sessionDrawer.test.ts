import { expect, test } from 'bun:test';

test('insets the mobile drawer content below the top safe area', async () => {
  const source = await Bun.file(new URL('./SessionDrawer.tsx', import.meta.url)).text();

  expect(source).toContain("<SafeAreaView edges={['top']} style={styles.panelContent}>");
});

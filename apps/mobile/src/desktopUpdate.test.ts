import { expect, mock, test } from 'bun:test';

const openUrl = mock(() => Promise.resolve());
mock.module('@tauri-apps/plugin-opener', () => ({ openUrl }));

const { openExternalUrl } = await import('./desktopUpdate');

test('opens terminal links through Tauri’s system-browser opener', async () => {
  await openExternalUrl('https://example.com/path');

  expect(openUrl).toHaveBeenCalledWith('https://example.com/path');
});

import { beforeEach, expect, mock, test } from 'bun:test';

const invoke = mock(() => Promise.resolve());
mock.module('@tauri-apps/api/core', () => ({ invoke }));

let tauri = true;
mock.module('./platform', () => ({
  isTauri: () => tauri,
  isDesktop: true,
  isMacDesktop: false,
}));

const { openExternalUrl } = await import('./desktopUpdate');

beforeEach(() => {
  invoke.mockClear();
});

test('opens terminal links through the Rust open_external command', async () => {
  tauri = true;
  await openExternalUrl('https://example.com/path');

  expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://example.com/path' });
});

test('falls back to window.open outside Tauri (browser dev preview)', async () => {
  tauri = false;
  const opened: string[] = [];
  (globalThis as { window?: unknown }).window = {
    open: (url: string) => opened.push(url),
  };
  try {
    await openExternalUrl('https://example.com/x');
    expect(opened).toEqual(['https://example.com/x']);
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

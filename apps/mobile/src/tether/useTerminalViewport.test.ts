import { expect, mock, test } from 'bun:test';

// useTerminalViewport reaches AsyncStorage and ../desktopNotify → ../platform,
// which imports Platform from react-native. Mock both here: relying on another
// test file to have registered them leaks across files, so this one passed only
// in a full serial run and failed alone or under --parallel.
mock.module('react-native', () => ({
  Platform: { OS: 'web' },
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

const { clampFontSize } = await import('./useTerminalViewport');

test('clampFontSize keeps terminal fonts within the supported range', () => {
  expect(clampFontSize(7)).toBe(8);
  expect(clampFontSize(11)).toBe(11);
  expect(clampFontSize(25)).toBe(24);
});

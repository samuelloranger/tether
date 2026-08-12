// AsyncStorage ships an official in-memory mock; AppThemeProvider reads it on
// mount, so without this every render hits a missing NativeModule.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Icon sets pull in expo-font -> expo-modules-core, which needs the native
// runtime. Components under test only care that an icon renders, not which.
jest.mock('@expo/vector-icons/Feather', () => 'Feather');
jest.mock('@expo/vector-icons/MaterialIcons', () => 'MaterialIcons');

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

// Fonts, clipboard and the drag-drop view all reach for native modules that do
// not exist under jest. The components under test never assert on them.
jest.mock('@expo-google-fonts/fira-code/useFonts', () => ({ useFonts: () => [true, null] }));
jest.mock('@expo-google-fonts/fira-code/400Regular', () => ({ FiraCode_400Regular: 'FiraCode' }));
jest.mock('@expo-google-fonts/jetbrains-mono/400Regular', () => ({
  JetBrainsMono_400Regular: 'JetBrainsMono',
}));
jest.mock('expo-clipboard', () => ({
  getStringAsync: jest.fn(async () => ''),
  setStringAsync: jest.fn(async () => true),
}));
jest.mock('expo-drag-drop-content-view', () => {
  const { View } = require('react-native');
  return { DragDropContentView: View };
});
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true })),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  MediaTypeOptions: { Images: 'Images' },
}));
jest.mock('expo-file-system', () => ({}));
// Push registration is iOS-only and no-ops under the test platform, but both
// modules touch native code at import time, so they need stubs for any suite
// that pulls in useTetherApp.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: false })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false })),
  getDevicePushTokenAsync: jest.fn(async () => ({ type: 'ios', data: '' })),
}));
jest.mock('expo-crypto', () => ({
  getRandomBytes: jest.fn((size: number) => new Uint8Array(size)),
}));

// react-native-webview asserts its native module exists at import time. The
// terminal renderer is faked per-suite where it matters; this keeps merely
// importing a screen that mounts a WebView from blowing up.
jest.mock('react-native-webview', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: View, WebView: View };
});

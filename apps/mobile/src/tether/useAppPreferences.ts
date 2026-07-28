import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import {
  DEFAULT_DESKTOP_NAVIGATION_MODE,
  DESKTOP_NAVIGATION_STORAGE_KEY,
  type DesktopNavigationMode,
  parseDesktopNavigationMode,
} from '../desktopNavigation';
import { isDesktop } from '../platform';

const KEY_SNIPPETS = 'tether_snippets';

export function parseSnippets(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((snippet): snippet is string => typeof snippet === 'string')
      : [];
  } catch {
    return [];
  }
}

export function useAppPreferences() {
  const [snippets, setSnippets] = useState<string[]>([]);
  const [desktopNavigationMode, setDesktopNavigationMode] = useState<DesktopNavigationMode>(
    DEFAULT_DESKTOP_NAVIGATION_MODE,
  );

  useEffect(() => {
    AsyncStorage.getItem(KEY_SNIPPETS)
      .then((value) => setSnippets(parseSnippets(value)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    AsyncStorage.getItem(DESKTOP_NAVIGATION_STORAGE_KEY)
      .then((value) => setDesktopNavigationMode(parseDesktopNavigationMode(value)))
      .catch(() => {});
  }, []);

  const persistSnippets = (next: string[]) => {
    setSnippets(next);
    AsyncStorage.setItem(KEY_SNIPPETS, JSON.stringify(next)).catch(() => {});
  };

  const selectDesktopNavigationMode = (mode: DesktopNavigationMode) => {
    setDesktopNavigationMode(mode);
    if (isDesktop) AsyncStorage.setItem(DESKTOP_NAVIGATION_STORAGE_KEY, mode).catch(() => {});
  };

  return {
    snippets,
    setSnippets,
    persistSnippets,
    desktopNavigationMode,
    selectDesktopNavigationMode,
  };
}

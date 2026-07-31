import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

const KEY_SNIPPETS = 'tether_snippets';
const KEY_SIDEBAR_PINNED = 'tether_sidebar_pinned';

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

export function parseSidebarPinned(value: string | null): boolean {
  return value === 'true';
}

export function useAppPreferences() {
  const [snippets, setSnippets] = useState<string[]>([]);
  const [sidebarPinned, setSidebarPinned] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY_SNIPPETS)
      .then((value) => setSnippets(parseSnippets(value)))
      .catch(() => {});
    AsyncStorage.getItem(KEY_SIDEBAR_PINNED)
      .then((value) => setSidebarPinned(parseSidebarPinned(value)))
      .catch(() => {});
  }, []);

  const persistSnippets = (next: string[]) => {
    setSnippets(next);
    AsyncStorage.setItem(KEY_SNIPPETS, JSON.stringify(next)).catch(() => {});
  };

  const persistSidebarPinned = (next: boolean) => {
    setSidebarPinned(next);
    AsyncStorage.setItem(KEY_SIDEBAR_PINNED, next ? 'true' : 'false').catch(() => {});
  };

  return {
    snippets,
    setSnippets,
    persistSnippets,
    sidebarPinned,
    persistSidebarPinned,
  };
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

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

  useEffect(() => {
    AsyncStorage.getItem(KEY_SNIPPETS)
      .then((value) => setSnippets(parseSnippets(value)))
      .catch(() => {});
  }, []);

  const persistSnippets = (next: string[]) => {
    setSnippets(next);
    AsyncStorage.setItem(KEY_SNIPPETS, JSON.stringify(next)).catch(() => {});
  };

  return {
    snippets,
    setSnippets,
    persistSnippets,
  };
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';
import {
  APP_THEMES,
  DEFAULT_SYSTEM_DARK_FLAVOR,
  DEFAULT_THEME_PREFERENCE,
  parseDarkFlavor,
  parseThemePreference,
  resolveFlavor,
  selectThemePreference,
  SYSTEM_DARK_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type AppTheme,
  type DarkFlavor,
  type ThemePreference,
} from './appTheme';

type AppThemeContextValue = {
  preference: ThemePreference;
  systemDarkFlavor: DarkFlavor;
  theme: AppTheme;
  setPreference: (next: ThemePreference) => void;
};

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export function AppThemeProvider({ children }: PropsWithChildren) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const [systemDarkFlavor, setSystemDarkFlavor] = useState<DarkFlavor>(DEFAULT_SYSTEM_DARK_FLAVOR);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(THEME_STORAGE_KEY),
      AsyncStorage.getItem(SYSTEM_DARK_THEME_STORAGE_KEY),
    ])
      .then(([storedPreference, storedDarkFlavor]) => {
        setPreferenceState(parseThemePreference(storedPreference));
        setSystemDarkFlavor(parseDarkFlavor(storedDarkFlavor));
      })
      .catch(() => {});
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    const selected = selectThemePreference(preference, systemDarkFlavor, next);
    setPreferenceState(selected.preference);
    setSystemDarkFlavor(selected.systemDarkFlavor);
    if (selected.systemDarkFlavor !== systemDarkFlavor) {
      void AsyncStorage.setItem(SYSTEM_DARK_THEME_STORAGE_KEY, selected.systemDarkFlavor).catch(() => {});
    }
    void AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(() => {});
  }, [preference, systemDarkFlavor]);

  const flavor = resolveFlavor(preference, systemScheme, systemDarkFlavor);
  const value = useMemo(
    () => ({ preference, systemDarkFlavor, theme: APP_THEMES[flavor], setPreference }),
    [preference, systemDarkFlavor, flavor, setPreference],
  );

  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
}

export function useAppTheme() {
  const value = useContext(AppThemeContext);
  if (!value) throw new Error('useAppTheme must be used inside AppThemeProvider');
  return value;
}

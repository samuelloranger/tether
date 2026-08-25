import { useState } from 'react';
import {
  type AppPreferences,
  loadPreferences,
  savePreferences,
  TERMINAL_FONTS,
  type TerminalFont,
  type ThemePreference,
} from './preferences';

interface SettingsScreenProps {
  onBack: () => void;
}

export function SettingsScreen({ onBack }: SettingsScreenProps) {
  const [prefs, setPrefs] = useState<AppPreferences>(() => loadPreferences());

  const update = (next: Partial<AppPreferences>) => {
    setPrefs((current) => {
      const merged = { ...current, ...next };
      savePreferences(merged);
      return merged;
    });
  };

  return (
    <div className="panel settings-panel">
      <button type="button" className="linkish back-link" onClick={onBack}>
        ← Sessions
      </button>
      <h1>Settings</h1>
      <label>
        Theme
        <select
          value={prefs.theme}
          onChange={(e) => update({ theme: e.target.value as ThemePreference })}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label>
        Terminal font
        <select
          value={prefs.terminalFont}
          onChange={(e) => update({ terminalFont: e.target.value as TerminalFont })}
        >
          {TERMINAL_FONTS.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function useAppPreferences() {
  const [prefs, setPrefs] = useState<AppPreferences>(() => loadPreferences());
  return {
    prefs,
    setPrefs: (next: AppPreferences) => {
      savePreferences(next);
      setPrefs(next);
    },
  };
}

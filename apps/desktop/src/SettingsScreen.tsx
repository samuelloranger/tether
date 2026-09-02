import { useState } from 'react';
import {
  type AppPreferences,
  loadPreferences,
  savePreferences,
  TAB_LAYOUT_LABELS,
  TAB_LAYOUTS,
  type TabLayout,
  TERMINAL_FONT_LABELS,
  TERMINAL_FONTS,
  type TerminalFont,
  THEME_LABELS,
  THEME_OPTIONS,
  type ThemePreference,
} from './preferences';

interface LocalSettingsProps {
  onBack: () => void;
  prefs: AppPreferences;
  onPrefsChange: (prefs: AppPreferences) => void;
}

/** Local client preferences (theme, font, notifications, tab layout). */
export function LocalSettingsScreen({ onBack, prefs, onPrefsChange }: LocalSettingsProps) {
  const update = (next: Partial<AppPreferences>) => {
    const merged = { ...prefs, ...next };
    savePreferences(merged);
    onPrefsChange(merged);
  };

  return (
    <div className="panel settings-panel">
      <button type="button" className="linkish back-link" onClick={onBack}>
        ← Sessions
      </button>
      <h1>Appearance</h1>
      <label>
        Theme
        <select
          value={prefs.theme}
          onChange={(e) => update({ theme: e.target.value as ThemePreference })}
        >
          {THEME_OPTIONS.map((theme) => (
            <option key={theme} value={theme}>
              {THEME_LABELS[theme]}
            </option>
          ))}
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
              {TERMINAL_FONT_LABELS[font]}
            </option>
          ))}
        </select>
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={prefs.notificationsEnabled}
          onChange={(e) => update({ notificationsEnabled: e.target.checked })}
        />
        Desktop notifications
      </label>
      <label>
        Tab layout
        <select
          value={prefs.tabLayout}
          onChange={(e) => update({ tabLayout: e.target.value as TabLayout })}
        >
          {TAB_LAYOUTS.map((layout) => (
            <option key={layout} value={layout}>
              {TAB_LAYOUT_LABELS[layout]}
            </option>
          ))}
        </select>
      </label>
      {prefs.tabLayout === 'sidebar' ? (
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={prefs.sidebarPinned}
            onChange={(e) => update({ sidebarPinned: e.target.checked })}
          />
          Pin session sidebar
        </label>
      ) : null}
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

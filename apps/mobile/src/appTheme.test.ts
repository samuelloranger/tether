import { describe, expect, it } from 'bun:test';
import {
  APP_THEMES,
  DEFAULT_SYSTEM_DARK_FLAVOR,
  parseDarkFlavor,
  parseThemePreference,
  resolveFlavor,
  selectThemePreference,
} from './appTheme';

describe('app theme preference', () => {
  it('accepts only supported persisted preferences', () => {
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('default-dark')).toBe('default-dark');
    expect(parseThemePreference('default-light')).toBe('default-light');
    expect(parseThemePreference('latte')).toBe('latte');
    expect(parseThemePreference('frappe')).toBe('frappe');
    expect(parseThemePreference('macchiato')).toBe('macchiato');
    expect(parseThemePreference('mocha')).toBe('mocha');
    expect(parseThemePreference('dracula')).toBe('system');
    expect(parseThemePreference(null)).toBe('system');
  });

  it('resolves System to Default light or Default dark from the OS', () => {
    expect(resolveFlavor('system', 'light')).toBe('default-light');
    expect(resolveFlavor('system', 'dark')).toBe('default-dark');
    expect(resolveFlavor('system', null)).toBe('default-dark');
    expect(resolveFlavor('system', 'unspecified', 'mocha')).toBe('default-dark');
    expect(resolveFlavor('frappe', 'light', 'mocha')).toBe('frappe');
    expect(parseDarkFlavor('latte')).toBe(DEFAULT_SYSTEM_DARK_FLAVOR);
    expect(parseDarkFlavor('default-dark')).toBe('default-dark');
    expect(parseDarkFlavor('mocha')).toBe('mocha');
  });

  it('provides matching UI, terminal, and keyboard values', () => {
    expect(APP_THEMES['default-light'].keyboardAppearance).toBe('light');
    expect(APP_THEMES['default-dark'].keyboardAppearance).toBe('dark');
    expect(APP_THEMES.latte.keyboardAppearance).toBe('light');
    expect(APP_THEMES.mocha.keyboardAppearance).toBe('dark');
    expect(APP_THEMES['default-dark'].colors.background).toBe('#0b0c0f');
    expect(APP_THEMES['default-dark'].colors.accent).toBe('#3ddc97');
    expect(APP_THEMES['default-light'].colors.background).toBe('#f4f5f7');
    expect(APP_THEMES['default-light'].colors.accent).toBe('#0b7a4b');
    expect(APP_THEMES['default-dark'].terminal.bg).toBe('#1e1e2e');
    expect(APP_THEMES['default-light'].terminal.bg).toBe('#eff1f5');
    expect(APP_THEMES.latte.colors.background).toBe('#eff1f5');
    expect(APP_THEMES.mocha.colors.background).toBe('#1e1e2e');
    expect(APP_THEMES.mocha.colors.overlay).toBe('#11111b99');
    expect(APP_THEMES.frappe.terminal.base16).toHaveLength(16);
    expect(APP_THEMES.macchiato.terminal.fg).toBe('#cad3f5');
  });

  it('remembers only explicit dark flavors for storage', () => {
    expect(selectThemePreference('system', 'default-dark', 'frappe')).toEqual({
      preference: 'frappe',
      systemDarkFlavor: 'frappe',
    });
    expect(selectThemePreference('frappe', 'frappe', 'default-light')).toEqual({
      preference: 'default-light',
      systemDarkFlavor: 'frappe',
    });
    expect(selectThemePreference('macchiato', 'macchiato', 'system')).toEqual({
      preference: 'system',
      systemDarkFlavor: 'macchiato',
    });
    expect(selectThemePreference('system', 'mocha', 'default-dark')).toEqual({
      preference: 'default-dark',
      systemDarkFlavor: 'default-dark',
    });
  });
});

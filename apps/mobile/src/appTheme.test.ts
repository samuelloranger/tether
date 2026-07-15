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
    expect(parseThemePreference('latte')).toBe('latte');
    expect(parseThemePreference('frappe')).toBe('frappe');
    expect(parseThemePreference('macchiato')).toBe('macchiato');
    expect(parseThemePreference('mocha')).toBe('mocha');
    expect(parseThemePreference('dracula')).toBe('system');
    expect(parseThemePreference(null)).toBe('system');
  });

  it('resolves System to fixed Latte or the remembered dark flavor', () => {
    expect(resolveFlavor('system', 'light')).toBe('latte');
    expect(resolveFlavor('system', 'dark', 'frappe')).toBe('frappe');
    expect(resolveFlavor('system', null, 'macchiato')).toBe('macchiato');
    expect(resolveFlavor('system', 'unspecified', 'frappe')).toBe('frappe');
    expect(resolveFlavor('frappe', 'light', 'mocha')).toBe('frappe');
    expect(parseDarkFlavor('latte')).toBe(DEFAULT_SYSTEM_DARK_FLAVOR);
    expect(parseDarkFlavor('mocha')).toBe('mocha');
  });

  it('provides matching UI, terminal, and keyboard values', () => {
    expect(APP_THEMES.latte.keyboardAppearance).toBe('light');
    expect(APP_THEMES.mocha.keyboardAppearance).toBe('dark');
    expect(APP_THEMES.latte.colors.background).toBe('#eff1f5');
    expect(APP_THEMES.mocha.colors.background).toBe('#1e1e2e');
    expect(APP_THEMES.mocha.colors.overlay).toBe('#11111b99');
    expect(APP_THEMES.frappe.terminal.base16).toHaveLength(16);
    expect(APP_THEMES.macchiato.terminal.fg).toBe('#cad3f5');
  });

  it('remembers only explicit dark flavors for System mode', () => {
    expect(selectThemePreference('system', 'mocha', 'frappe')).toEqual({
      preference: 'frappe',
      systemDarkFlavor: 'frappe',
    });
    expect(selectThemePreference('frappe', 'frappe', 'latte')).toEqual({
      preference: 'latte',
      systemDarkFlavor: 'frappe',
    });
    expect(selectThemePreference('macchiato', 'macchiato', 'system')).toEqual({
      preference: 'system',
      systemDarkFlavor: 'macchiato',
    });
  });

});

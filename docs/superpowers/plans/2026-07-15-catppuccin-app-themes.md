# Catppuccin App Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent Catppuccin application themes that style Tether’s complete UI and terminal on iOS, Android, and Tauri desktops.

**Architecture:** A single `appTheme.tsx` provider owns persistence, system-scheme resolution, official Catppuccin values, semantic UI tokens, and the matching terminal palette. It wraps `AppInner`; all components consume its resolved theme. `useTetherApp` applies that terminal palette and recomputes the active snapshot, avoiding a socket reconnect.

**Tech Stack:** Expo SDK 57, React 19, React Native 0.86, React Native Web, AsyncStorage, Bun test, Tauri 2.

## Global Constraints

- Read the exact [Expo SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/) before editing mobile code, as required by `apps/mobile/AGENTS.md`.
- Support only `system`, `latte`, `frappe`, `macchiato`, and `mocha`.
- System resolves to Latte for a light OS scheme and to the separately remembered dark flavor for dark or unknown schemes; Mocha is the first-run fallback.
- Use official Catppuccin values embedded in source; add no dependency.
- A selection changes UI chrome, terminal colors, and native keyboard appearance immediately.
- Maintain one shared implementation for iOS, Android, React Native Web, and Tauri desktop (macOS, Windows, Linux).
- Reuse `tether_theme`; old `default`, `dracula`, and `solarized-dark` values safely resolve to System. Persist the remembered System dark flavor under `tether_system_dark_theme`; absent/invalid values become Mocha.
- Preserve unrelated untracked files.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/mobile/src/appTheme.tsx` | Palette data, terminal mapping, preference parsing/resolution, AsyncStorage persistence, and React context. |
| `apps/mobile/src/appTheme.test.ts` | Theme parsing, System resolution, semantic palette, keyboard, and terminal contract tests. |
| `apps/mobile/App.tsx` | Provider placement and resolved root surface. |
| `apps/mobile/src/useTetherApp.tsx` | Apply current terminal palette and refresh snapshot; remove terminal-only preference state. |
| `apps/mobile/src/terminal.test.ts` | Catppuccin terminal default/ANSI regression tests. |
| `apps/mobile/src/themes.ts` | Delete after its retired terminal-only palettes have no consumers. |
| `apps/mobile/src/styles.ts` | Convert shared dark-only styles to a semantic color factory. |
| `apps/mobile/src/{ConfigScreen,TerminalScreen,TermRow,ConnectionBanner,UtilityBar,Dpad,SelectionView,SessionDrawer,DesktopSessionNavigator,OverflowMenu,SessionModals,UpdateModal,ContextMenu,TitleBar}.tsx` | Replace local dark-only colors with the shared semantic theme. |

### Task 1: Build the theme domain and prove its contract

**Files:**
- Create: `apps/mobile/src/appTheme.tsx`
- Create: `apps/mobile/src/appTheme.test.ts`

**Interfaces:**
- Produces: `ThemePreference`, `DarkFlavor`, `ResolvedFlavor`, `AppColors`, `AppTheme`, `THEME_OPTIONS`, `parseThemePreference(value)`, `parseDarkFlavor(value)`, `resolveFlavor(preference, scheme, systemDarkFlavor)`, `APP_THEMES`, `AppThemeProvider`, and `useAppTheme()`.
- Consumes later: `AppTheme.terminal` conforms to the existing `Theme` interface in `terminal.ts`.

- [ ] **Step 1: Write failing contract tests**

Create `apps/mobile/src/appTheme.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  APP_THEMES,
  DEFAULT_THEME_PREFERENCE,
  DEFAULT_SYSTEM_DARK_FLAVOR,
  parseDarkFlavor,
  parseThemePreference,
  resolveFlavor,
} from './appTheme';

describe('app theme preference', () => {
  it('accepts only supported persisted preferences', () => {
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('latte')).toBe('latte');
    expect(parseThemePreference('frappe')).toBe('frappe');
    expect(parseThemePreference('macchiato')).toBe('macchiato');
    expect(parseThemePreference('mocha')).toBe('mocha');
    expect(parseThemePreference('dracula')).toBe(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference(null)).toBe(DEFAULT_THEME_PREFERENCE);
  });

  it('resolves System to fixed Latte or the remembered dark flavor', () => {
    expect(resolveFlavor('system', 'light')).toBe('latte');
    expect(resolveFlavor('system', 'dark', 'frappe')).toBe('frappe');
    expect(resolveFlavor('system', null, 'macchiato')).toBe('macchiato');
    expect(resolveFlavor('frappe', 'light', 'mocha')).toBe('frappe');
    expect(parseDarkFlavor('latte')).toBe(DEFAULT_SYSTEM_DARK_FLAVOR);
    expect(parseDarkFlavor('mocha')).toBe('mocha');
  });

  it('provides matching UI, terminal, and keyboard values', () => {
    expect(APP_THEMES.latte.keyboardAppearance).toBe('light');
    expect(APP_THEMES.mocha.keyboardAppearance).toBe('dark');
    expect(APP_THEMES.latte.colors.background).toBe('#eff1f5');
    expect(APP_THEMES.mocha.colors.background).toBe('#1e1e2e');
    expect(APP_THEMES.frappe.terminal.base16).toHaveLength(16);
    expect(APP_THEMES.macchiato.terminal.fg).toBe('#cad3f5');
  });
});
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `cd apps/mobile && bun test src/appTheme.test.ts`

Expected: FAIL because `./appTheme` does not exist.

- [ ] **Step 3: Implement palette data, resolution, and the provider**

Create `apps/mobile/src/appTheme.tsx` with these public types and functions:

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';
import type { Theme as TerminalTheme } from './terminal';

export const THEME_STORAGE_KEY = 'tether_theme';
export const SYSTEM_DARK_THEME_STORAGE_KEY = 'tether_system_dark_theme';
export const THEME_OPTIONS = ['system', 'latte', 'frappe', 'macchiato', 'mocha'] as const;
export type ThemePreference = (typeof THEME_OPTIONS)[number];
export type ResolvedFlavor = Exclude<ThemePreference, 'system'>;
export type DarkFlavor = Exclude<ResolvedFlavor, 'latte'>;
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';
export const DEFAULT_SYSTEM_DARK_FLAVOR: DarkFlavor = 'mocha';

export function parseThemePreference(value: string | null): ThemePreference {
  return THEME_OPTIONS.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : DEFAULT_THEME_PREFERENCE;
}

export function resolveFlavor(
  preference: ThemePreference,
  scheme: 'light' | 'dark' | null | undefined,
  systemDarkFlavor: DarkFlavor = DEFAULT_SYSTEM_DARK_FLAVOR,
): ResolvedFlavor {
  return preference === 'system' ? (scheme === 'light' ? 'latte' : systemDarkFlavor) : preference;
}

export function parseDarkFlavor(value: string | null): DarkFlavor {
  return value === 'frappe' || value === 'macchiato' || value === 'mocha'
    ? value
    : DEFAULT_SYSTEM_DARK_FLAVOR;
}

export interface AppColors {
  background: string; surface: string; surfaceRaised: string; input: string;
  text: string; textMuted: string; textFaint: string; border: string;
  overlay: string; selected: string; accent: string; accentText: string;
  success: string; warning: string; danger: string; info: string;
}
export interface AppTheme {
  flavor: ResolvedFlavor;
  colors: AppColors;
  terminal: TerminalTheme;
  keyboardAppearance: 'light' | 'dark';
}
```

Embed these official base colors exactly. The implementation must retain all shown keys and must not import a palette package:

```ts
const PALETTES = {
  latte: { crust:'#dce0e8', mantle:'#e6e9ef', base:'#eff1f5', surface0:'#ccd0da', surface1:'#bcc0cc', text:'#4c4f69', subtext0:'#6c6f85', overlay0:'#9ca0b0', red:'#d20f39', green:'#40a02b', yellow:'#df8e1d', blue:'#1e66f5', mauve:'#8839ef', pink:'#ea76cb', teal:'#179299', sky:'#04a5e5' },
  frappe: { crust:'#232634', mantle:'#292c3c', base:'#303446', surface0:'#414559', surface1:'#51576d', text:'#c6d0f5', subtext0:'#a5adce', overlay0:'#737994', red:'#e78284', green:'#a6d189', yellow:'#e5c890', blue:'#8caaee', mauve:'#ca9ee6', pink:'#f4b8e4', teal:'#81c8be', sky:'#99d1db' },
  macchiato: { crust:'#181926', mantle:'#1e2030', base:'#24273a', surface0:'#363a4f', surface1:'#494d64', text:'#cad3f5', subtext0:'#a5adcb', overlay0:'#6e738d', red:'#ed8796', green:'#a6da95', yellow:'#eed49f', blue:'#8aadf4', mauve:'#c6a0f6', pink:'#f5bde6', teal:'#8bd5ca', sky:'#91d7e3' },
  mocha: { crust:'#11111b', mantle:'#181825', base:'#1e1e2e', surface0:'#313244', surface1:'#45475a', text:'#cdd6f4', subtext0:'#a6adc8', overlay0:'#6c7086', red:'#f38ba8', green:'#a6e3a1', yellow:'#f9e2af', blue:'#89b4fa', mauve:'#cba6f7', pink:'#f5c2e7', teal:'#94e2d5', sky:'#89dceb' },
} as const;
```

For each flavor map `base→background`, `mantle→surface`, `surface0→surfaceRaised`, `crust→input`, `text→text`, `subtext0→textMuted`, `overlay0→textFaint`, `surface1→border`, `#0000008c→overlay`, `surface1→selected`, `mauve→accent`, `base→accentText`, and `green/yellow/red/blue→success/warning/danger/info`. Build terminal colors as:

```ts
const terminal: TerminalTheme = {
  base16: [p.crust, p.red, p.green, p.yellow, p.blue, p.mauve, p.teal, p.text,
    p.surface1, p.red, p.green, p.yellow, p.blue, p.pink, p.sky, p.text],
  fg: p.text,
  bg: p.base,
};
```

Provide the context with this complete behavior:

```tsx
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
    Promise.all([AsyncStorage.getItem(THEME_STORAGE_KEY), AsyncStorage.getItem(SYSTEM_DARK_THEME_STORAGE_KEY)])
      .then(([storedPreference, storedDarkFlavor]) => {
        setPreferenceState(parseThemePreference(storedPreference));
        setSystemDarkFlavor(parseDarkFlavor(storedDarkFlavor));
      })
      .catch(() => {});
  }, []);
  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    void AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(() => {});
    if (next !== 'system' && next !== 'latte') {
      setSystemDarkFlavor(next);
      void AsyncStorage.setItem(SYSTEM_DARK_THEME_STORAGE_KEY, next).catch(() => {});
    }
  };
  const flavor = resolveFlavor(preference, systemScheme, systemDarkFlavor);
  const value = useMemo(
    () => ({ preference, systemDarkFlavor, theme: APP_THEMES[flavor], setPreference }),
    [preference, systemDarkFlavor, flavor],
  );
  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
}
export function useAppTheme() {
  const value = useContext(AppThemeContext);
  if (!value) throw new Error('useAppTheme must be used inside AppThemeProvider');
  return value;
}
```

- [ ] **Step 4: Run the focused test and confirm green**

Run: `cd apps/mobile && bun test src/appTheme.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit the isolated domain boundary**

```bash
git add apps/mobile/src/appTheme.tsx apps/mobile/src/appTheme.test.ts
git commit -m "feat(mobile): add Catppuccin theme provider"
```

### Task 2: Wire provider, terminal repaint, and Appearance selection

**Files:**
- Modify: `apps/mobile/App.tsx:1-42`
- Modify: `apps/mobile/src/useTetherApp.tsx:31-75, 203-212, 439-457, 1316`
- Modify: `apps/mobile/src/SessionModals.tsx:1-176`
- Modify: `apps/mobile/src/TerminalScreen.tsx:49, 365-377, 420`
- Modify: `apps/mobile/src/SelectionView.tsx:73`
- Modify: `apps/mobile/src/terminal.test.ts:1-10, existing SGR/default-color assertions`
- Delete: `apps/mobile/src/themes.ts`

**Interfaces:**
- Consumes: `AppThemeProvider`, `useAppTheme`, `APP_THEMES`, and `ThemePreference` from Task 1.
- Produces: one provider-wrapped application, five Appearance choices, immediate terminal repaint, and no old terminal-palette state.

- [ ] **Step 1: Add failing Catppuccin emulator assertions**

In `apps/mobile/src/terminal.test.ts`, import `APP_THEMES` and add:

```ts
import { APP_THEMES } from './appTheme';

setTheme(APP_THEMES.mocha.terminal);

{
  setTheme(APP_THEMES.latte.terminal);
  const t = new TerminalEmulator(80, 24);
  t.write(`plain ${E}[31mred`);
  const runs = t.getSnapshot()[0].runs;
  eq(runs.find((r) => r.text.startsWith('plain'))?.style.fg, '#4c4f69', 'Latte default foreground');
  eq(runs.find((r) => r.text === 'red')?.style.fg, '#d20f39', 'Latte ANSI red');
}
setTheme(APP_THEMES.mocha.terminal);
```

Change the current split-SGR assertion from retired default red `#cd3131` to Mocha red `#f38ba8`. In the existing final `setTheme swaps the ANSI palette` test, replace its handwritten old-default restore object with `setTheme(APP_THEMES.mocha.terminal)`.

- [ ] **Step 2: Run the emulator test and confirm red**

Run: `cd apps/mobile && bun test src/terminal.test.ts`

Expected: FAIL until the terminal test setup and provider dependencies are integrated.

- [ ] **Step 3: Install context at the root and remove terminal-only state**

Wrap `AppInner` in `AppThemeProvider` in `App.tsx`. Inside `AppInner`, consume `theme` and layer `theme.colors.background` over the safe-area root.

In `useTetherApp.tsx`, delete `THEMES`, `KEY_THEME`, `themeId`, its load effect, `changeTheme`, and their returned fields. Consume `theme` from `useAppTheme` and add this effect after `cache` and `activeIdRef` exist:

```tsx
useEffect(() => {
  setTheme(theme.terminal);
  const active = cache.get(activeIdRef.current);
  if (active) setScreen(active.term.getSnapshot());
}, [theme, cache]);
```

Do not reset the emulator and do not reconnect the socket.

Change `AppearanceModal` to call `useAppTheme()`, render `THEME_OPTIONS` with labels `System`, `Latte`, `Frappé`, `Macchiato`, and `Mocha`, and select by the stored `preference`. Remove `themeId` and `onThemeChange` props through `TerminalScreen`. Retain the desktop-only font picker. Change each hardcoded `keyboardAppearance="dark"` in `SessionModals.tsx`, `TerminalScreen.tsx`, and `SelectionView.tsx` to `theme.keyboardAppearance`.

- [ ] **Step 4: Run focused checks and confirm green**

```bash
cd apps/mobile && bun test src/appTheme.test.ts src/terminal.test.ts
cd apps/mobile && bun run lint
```

Expected: both test files pass and TypeScript reports no errors.

- [ ] **Step 5: Commit terminal integration**

```bash
git add apps/mobile/App.tsx apps/mobile/src/useTetherApp.tsx apps/mobile/src/SessionModals.tsx apps/mobile/src/TerminalScreen.tsx apps/mobile/src/SelectionView.tsx apps/mobile/src/terminal.test.ts apps/mobile/src/themes.ts
git commit -m "feat(mobile): apply Catppuccin theme to terminal"
```

### Task 3: Convert every visual surface to semantic colors

**Files:**
- Modify: `apps/mobile/App.tsx`
- Modify: `apps/mobile/src/styles.ts`
- Modify: `apps/mobile/src/ConfigScreen.tsx`
- Modify: `apps/mobile/src/TerminalScreen.tsx`
- Modify: `apps/mobile/src/TermRow.tsx`
- Modify: `apps/mobile/src/ConnectionBanner.tsx`
- Modify: `apps/mobile/src/UtilityBar.tsx`
- Modify: `apps/mobile/src/Dpad.tsx`
- Modify: `apps/mobile/src/SelectionView.tsx`
- Modify: `apps/mobile/src/SessionDrawer.tsx`
- Modify: `apps/mobile/src/DesktopSessionNavigator.tsx`
- Modify: `apps/mobile/src/OverflowMenu.tsx`
- Modify: `apps/mobile/src/SessionModals.tsx`
- Modify: `apps/mobile/src/UpdateModal.tsx`
- Modify: `apps/mobile/src/ContextMenu.tsx`
- Modify: `apps/mobile/src/TitleBar.tsx`

**Interfaces:**
- Consumes: `useAppTheme().theme.colors` and `theme.keyboardAppearance`.
- Produces: no dark-only UI color remains outside the Catppuccin palette record.

- [ ] **Step 1: Record the expected failing legacy-color audit**

Run:

```bash
cd apps/mobile && rg -n "#(030712|05070e|070a13|0b0f19|3730a3|818cf8|cbd5e1|e2e8f0|94a3b8|64748b|f87171)|rgba\\(255, ?255, ?255" App.tsx src
```

Expected: legacy UI colors are reported in the files listed above.

- [ ] **Step 2: Apply semantic-token mapping in all listed files**

Retain static geometry in local `StyleSheet.create` objects. At component scope call `useAppTheme()` and layer color values over static styles. Apply this required mapping everywhere:

```ts
background / terminal scroll       => colors.background
headers, bars, drawers, cards      => colors.surface
raised menu rows and chips         => colors.surfaceRaised
text inputs                        => colors.input
primary / muted / empty text       => colors.text / colors.textMuted / colors.textFaint
separators and input outlines      => colors.border
scrims                             => colors.overlay
active rows and tabs               => colors.selected
primary action and terminal caret  => colors.accent
text on primary action             => colors.accentText
connection and destructive states  => colors.success / colors.warning / colors.danger / colors.info
```

In `styles.ts`, preserve `MONO` and export `createStyles(colors: AppColors)` instead of a color-bound `styles` constant. Call it with `useMemo(() => createStyles(theme.colors), [theme.colors])` in `ConfigScreen`, `TerminalScreen`, and `useTetherApp`, its only shared-style consumers.

In `TermRow`, take `accent`, `accentText`, and terminal default foreground as props (or read the context directly). Replace the hardcoded caret border/background/text colors and `termLine` default color. Include those theme values in the `React.memo` comparator so a flavor switch repaints an unchanged row.

In `SessionModals`, show an accent-color swatch for each explicit flavor using `APP_THEMES[id].colors.accent`; System has no swatch. The checkmark/selected row remains based on stored preference, not resolved flavor. Selecting Frappé, Macchiato, or Mocha also updates the remembered System dark flavor; selecting Latte does not. Keep all current callbacks, session navigation, desktop font selection, update actions, and window controls unchanged.

- [ ] **Step 3: Re-run audit, test suite, typecheck, and web export**

```bash
cd apps/mobile && rg -n "#(030712|05070e|070a13|0b0f19|3730a3|818cf8|cbd5e1|e2e8f0|94a3b8|64748b|f87171)|rgba\\(255, ?255, ?255" App.tsx src
cd apps/mobile && bun test
cd apps/mobile && bun run lint
cd apps/mobile && bun run build:web
```

Expected: the audit finds no legacy UI token outside `appTheme.tsx`; all Bun tests pass; TypeScript reports no errors; Expo produces a web export.

- [ ] **Step 4: Commit complete UI conversion**

```bash
git add apps/mobile/App.tsx apps/mobile/src/styles.ts apps/mobile/src/ConfigScreen.tsx apps/mobile/src/TerminalScreen.tsx apps/mobile/src/TermRow.tsx apps/mobile/src/ConnectionBanner.tsx apps/mobile/src/UtilityBar.tsx apps/mobile/src/Dpad.tsx apps/mobile/src/SelectionView.tsx apps/mobile/src/SessionDrawer.tsx apps/mobile/src/DesktopSessionNavigator.tsx apps/mobile/src/OverflowMenu.tsx apps/mobile/src/SessionModals.tsx apps/mobile/src/UpdateModal.tsx apps/mobile/src/ContextMenu.tsx apps/mobile/src/TitleBar.tsx
git commit -m "feat(mobile): theme all app surfaces"
```

### Task 4: Verify platform behavior and close the gate

**Files:**
- Modify only if a check below identifies a defect: the exact affected file from Tasks 1–3.
- Test: `apps/mobile/src/appTheme.test.ts` or `apps/mobile/src/terminal.test.ts` for any observed regression.

**Interfaces:**
- Consumes: complete provider, terminal integration, and semantic UI conversion.
- Produces: verified behavior on iOS, Android, and Tauri desktop without speculative platform code.

- [ ] **Step 1: Run the complete automated gate**

```bash
cd apps/mobile && bun test
cd apps/mobile && bun run lint
cd apps/mobile && bun run build:web
git diff --check
```

Expected: all tests pass, TypeScript reports no errors, Expo exports the web build, and the diff has no whitespace errors.

- [ ] **Step 2: Perform platform acceptance**

On iOS, Android, and a Tauri desktop app, verify:

```text
1. Missing or old tether_theme starts as System with Mocha as the remembered dark fallback.
2. System is Latte under light OS appearance and uses the remembered Frappé, Macchiato, or Mocha under dark OS appearance.
3. An OS change while System is selected repaints chrome and existing terminal output without reconnecting.
4. Latte, Frappé, Macchiato, and Mocha persist after a full restart.
5. Setup, terminal, terminal ANSI/default colors, input bars, drawers/sidebar/tabs, overflow, all modals, context menu, update dialog, and native keyboard contrast match the resolved flavor.
6. Desktop navigation modes, font picker, terminal input, and Tauri window controls retain existing behavior.
```

- [ ] **Step 3: Repair only an observed failure with a focused regression check**

If acceptance finds a defect, first add an assertion to `appTheme.test.ts` for parsing/resolution/palette behavior or to `terminal.test.ts` for terminal repaint/color behavior. Run the exact test to observe the failure, make the smallest correction in the affected file, then rerun the complete automated gate from Step 1.

- [ ] **Step 4: Commit an observed platform fix only when one was required**

```bash
git add apps/mobile/App.tsx apps/mobile/src/appTheme.tsx apps/mobile/src/appTheme.test.ts apps/mobile/src/terminal.test.ts apps/mobile/src/*.tsx apps/mobile/src/*.ts
git commit -m "fix(mobile): preserve Catppuccin themes across platforms"
```

Do not create this commit when acceptance finds no defect; Tasks 1–3 already provide independently reviewable commits.

## Self-Review

- Spec coverage: Task 1 defines all four official flavors and System behavior; Task 2 persists them and synchronizes terminal rendering; Task 3 converts every named dark-only surface; Task 4 validates iOS, Android, and Tauri desktop behavior.
- Scope is one provider and a mechanical use of existing React Native styles. It adds neither a dependency nor a second web/native theming system.
- The interfaces `ThemePreference`, `ResolvedFlavor`, `AppTheme`, `APP_THEMES`, and `useAppTheme` are consistently named across every task.
- Persistence has deterministic fallbacks: old app-theme values parse as System and a missing/invalid remembered dark flavor parses as Mocha.

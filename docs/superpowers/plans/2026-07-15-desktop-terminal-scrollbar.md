# Desktop Terminal Scrollbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop terminal a slim, theme-matched native scrollbar while leaving mobile unchanged.

**Architecture:** Add one small desktop-CSS helper that injects scoped native-scrollbar rules once. `TerminalScreen` supplies the active theme through CSS custom properties on the existing `#tether-terminal` view, so a theme change updates scrollbar colors without a second style element or new state.

**Tech Stack:** TypeScript, React Native Web, Tauri WebView, Bun tests, Expo web export.

## Global Constraints

- Change only the desktop terminal element (`#tether-terminal`); mobile must keep its current behavior.
- Use native CSS scrollbar APIs only: Firefox `scrollbar-width`/`scrollbar-color` and WebKit `::-webkit-scrollbar*` selectors.
- Reuse `AppTheme` colors: `theme.terminal.bg` for the track, `theme.colors.border` for the thumb, and `theme.colors.selected` on hover.
- Add no dependencies, preference, state, or user-facing controls.

---

## File structure

| File | Responsibility |
| --- | --- |
| `apps/mobile/src/terminalScrollbar.ts` | Owns the scoped static CSS and one-time DOM style injection. |
| `apps/mobile/src/terminalScrollbar.test.ts` | Locks the selector scope and native-browser fallback rules. |
| `apps/mobile/src/TerminalScreen.tsx` | Injects the desktop stylesheet and binds active theme values to the terminal DOM element. |

### Task 1: Scoped terminal scrollbar styles

**Files:**
- Create: `apps/mobile/src/terminalScrollbar.ts`
- Create: `apps/mobile/src/terminalScrollbar.test.ts`
- Modify: `apps/mobile/src/TerminalScreen.tsx:72-75, 303-318`

**Interfaces:**
- Produces: `TERMINAL_SCROLLBAR_CSS: string` and `injectTerminalScrollbarStyles(): void` from `terminalScrollbar.ts`.
- Consumes: `isDesktop` from `platform.ts` and the existing `theme` returned by `useAppTheme()`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/mobile/src/terminalScrollbar.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { TERMINAL_SCROLLBAR_CSS } from './terminalScrollbar';

describe('terminal scrollbar CSS', () => {
  test('is scoped to the terminal and covers Firefox plus WebKit', () => {
    expect(TERMINAL_SCROLLBAR_CSS).toContain('#tether-terminal');
    expect(TERMINAL_SCROLLBAR_CSS).toContain('scrollbar-width: thin');
    expect(TERMINAL_SCROLLBAR_CSS).toContain('scrollbar-color: var(--tether-scrollbar-thumb) var(--tether-scrollbar-track)');
    expect(TERMINAL_SCROLLBAR_CSS).toContain('#tether-terminal::-webkit-scrollbar');
    expect(TERMINAL_SCROLLBAR_CSS).toContain('#tether-terminal::-webkit-scrollbar-thumb:hover');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mobile/src/terminalScrollbar.test.ts`

Expected: FAIL because `./terminalScrollbar` does not exist.

- [ ] **Step 3: Add the minimal CSS helper**

Create `apps/mobile/src/terminalScrollbar.ts`:

```ts
export const TERMINAL_SCROLLBAR_CSS = `
#tether-terminal {
  scrollbar-width: thin;
  scrollbar-color: var(--tether-scrollbar-thumb) var(--tether-scrollbar-track);
}
#tether-terminal::-webkit-scrollbar { width: 10px; height: 10px; }
#tether-terminal::-webkit-scrollbar-track { background: var(--tether-scrollbar-track); }
#tether-terminal::-webkit-scrollbar-thumb {
  background: var(--tether-scrollbar-thumb);
  border: 2px solid var(--tether-scrollbar-track);
  border-radius: 999px;
}
#tether-terminal::-webkit-scrollbar-thumb:hover { background: var(--tether-scrollbar-thumb-hover); }
`;

const STYLE_ID = 'tether-terminal-scrollbar-styles';

export function injectTerminalScrollbarStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TERMINAL_SCROLLBAR_CSS;
  document.head.appendChild(style);
}
```

In `apps/mobile/src/TerminalScreen.tsx`, import `injectTerminalScrollbarStyles` beside the existing local helpers. Add this effect after `const styles = ...`:

```ts
useEffect(() => {
  if (isDesktop) injectTerminalScrollbarStyles();
}, []);
```

Replace the desktop terminal view at lines 316-318 with this CSS-variable-bearing version:

```tsx
<View
  nativeID="tether-terminal"
  style={{
    flex: 1,
    '--tether-scrollbar-track': theme.terminal.bg,
    '--tether-scrollbar-thumb': theme.colors.border,
    '--tether-scrollbar-thumb-hover': theme.colors.selected,
  } as any}
>
  {terminalGrid}
</View>
```

- [ ] **Step 4: Run focused checks**

Run: `bun test apps/mobile/src/terminalScrollbar.test.ts && bun run --cwd apps/mobile lint`

Expected: test passes and TypeScript exits 0.

- [ ] **Step 5: Run integration verification**

Run: `bun run --cwd apps/mobile build:web && git diff --check`

Expected: Expo web export completes and `git diff --check` has no output.

Manually verify in Tauri desktop:

1. Produce enough output for the terminal to scroll.
2. Confirm the scrollbar is slim, uses the terminal background track, and brightens on hover.
3. Switch among Latte, Frappé, Macchiato, and Mocha; confirm the scrollbar recolors immediately.
4. Open a preview and confirm its scrollbar remains native.
5. Confirm the mobile terminal has no visual or interaction change.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/terminalScrollbar.ts apps/mobile/src/terminalScrollbar.test.ts apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(desktop): theme terminal scrollbar"
```

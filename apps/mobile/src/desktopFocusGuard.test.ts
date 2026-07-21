import { describe, expect, it } from 'bun:test';
import { type FocusEl, shouldForwardToTerminal } from './desktopFocusGuard';

function el(overrides: Partial<FocusEl> = {}): FocusEl {
  return {
    id: '',
    tagName: 'DIV',
    isContentEditable: false,
    getAttribute: () => null,
    closest: () => null,
    ...overrides,
  };
}

describe('shouldForwardToTerminal', () => {
  it('forwards when nothing is focused (null) or focus is on body', () => {
    expect(shouldForwardToTerminal(null, false)).toBe(true);
    expect(shouldForwardToTerminal(el(), true)).toBe(true);
  });
  it('does not forward while a takeover view hides the terminal', () => {
    expect(shouldForwardToTerminal(null, true, false)).toBe(false);
  });
  it('forwards when the terminal surface itself (or a descendant) is focused', () => {
    expect(shouldForwardToTerminal(el({ id: 'tether-terminal' }), false)).toBe(true);
    expect(
      shouldForwardToTerminal(
        el({ closest: (sel) => (sel === '#tether-terminal' ? {} : null) }),
        false,
      ),
    ).toBe(true);
  });
  it('does not forward when a real text field is focused', () => {
    expect(shouldForwardToTerminal(el({ tagName: 'INPUT' }), false)).toBe(false);
    expect(shouldForwardToTerminal(el({ tagName: 'TEXTAREA' }), false)).toBe(false);
    expect(shouldForwardToTerminal(el({ isContentEditable: true }), false)).toBe(false);
  });
  it('does not forward when a focusable control (button/link/menuitem/tabindex) is focused', () => {
    expect(shouldForwardToTerminal(el({ tagName: 'BUTTON' }), false)).toBe(false);
    expect(
      shouldForwardToTerminal(
        el({ getAttribute: (n) => (n === 'role' ? 'menuitem' : null) }),
        false,
      ),
    ).toBe(false);
    expect(
      shouldForwardToTerminal(el({ getAttribute: (n) => (n === 'tabindex' ? '0' : null) }), false),
    ).toBe(false);
  });
  it('forwards for a plain non-interactive element (e.g. body-adjacent wrapper divs)', () => {
    expect(shouldForwardToTerminal(el({ tagName: 'DIV' }), false)).toBe(true);
  });
});

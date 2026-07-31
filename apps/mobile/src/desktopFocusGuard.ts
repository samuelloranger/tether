// Desktop keyboard/composition capture must not hijack a real UI control: text
// fields need to type normally, and Enter/Space must activate a focused button
// (New terminal, Settings, the overflow menu, Kill) instead of leaking into the
// shell. The terminal surface itself is exempt so click-to-focus then type
// still works. Nothing focused (body) → forward, the common case.
//
// A minimal structural type (not the DOM lib's HTMLElement) so this stays a
// pure, unit-testable function — the caller passes document.activeElement.
export interface FocusEl {
  id: string;
  tagName: string;
  isContentEditable?: boolean;
  getAttribute(name: string): string | null;
  closest?(selector: string): unknown;
}

export function shouldForwardToTerminal(
  el: FocusEl | null,
  isBody: boolean,
  terminalVisible = true,
): boolean {
  if (!terminalVisible) return false;
  if (!el || isBody) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) {
    return false;
  }
  const onTerminal = el.id === 'tether-terminal' || !!el.closest?.('#tether-terminal');
  if (onTerminal) return true;
  const role = el.getAttribute('role');
  if (
    tag === 'BUTTON' ||
    tag === 'A' ||
    role === 'button' ||
    role === 'link' ||
    role === 'menuitem' ||
    el.getAttribute('tabindex') != null
  ) {
    return false;
  }
  return true;
}

/** Nav keys for the PTY — includes focus inside the terminal surface (xterm
 *  helper textarea + hidden IME input), which shouldForward skips as TEXTAREA/INPUT. */
export function terminalAcceptsNavKeys(
  el: FocusEl | null,
  isBody: boolean,
  terminalVisible: boolean,
  isXtermHelperTextarea: boolean,
): boolean {
  if (!terminalVisible) return false;
  if (isXtermHelperTextarea) return true;
  // Hidden IME TextInput and xterm live under #tether-terminal; arrows must
  // reach the PTY even though shouldForward leaves those fields alone.
  if (el && (el.id === 'tether-terminal' || !!el.closest?.('#tether-terminal'))) {
    return true;
  }
  return shouldForwardToTerminal(el, isBody, terminalVisible);
}

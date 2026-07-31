import { describe, expect, test } from 'bun:test';
import { injectTerminalScrollbarStyles, TERMINAL_SCROLLBAR_CSS } from './terminalScrollbar';

describe('terminal scrollbar CSS', () => {
  test('is scoped to the terminal and covers Firefox plus WebKit', () => {
    expect(TERMINAL_SCROLLBAR_CSS).toContain('#tether-terminal');
    expect(TERMINAL_SCROLLBAR_CSS).toContain('scrollbar-width: thin');
    expect(TERMINAL_SCROLLBAR_CSS).toContain(
      'scrollbar-color: var(--tether-scrollbar-thumb) var(--tether-scrollbar-track)',
    );
    expect(TERMINAL_SCROLLBAR_CSS).toContain('#tether-terminal::-webkit-scrollbar');
    expect(TERMINAL_SCROLLBAR_CSS).toContain('#tether-terminal::-webkit-scrollbar-thumb:hover');
  });

  test('injects real colors into the custom properties the CSS reads', () => {
    const properties: Record<string, string> = {};
    const fakeDocument = {
      documentElement: { style: { setProperty: (k: string, v: string) => (properties[k] = v) } },
      getElementById: () => null,
      createElement: () => ({ textContent: '' }) as unknown as HTMLStyleElement,
      head: { appendChild: () => {} },
    };
    // @ts-expect-error -- minimal fake, this module only touches document via these members
    globalThis.document = fakeDocument;
    injectTerminalScrollbarStyles({ thumb: '#111', thumbHover: '#222', track: '#333' });
    // @ts-expect-error -- see above
    delete globalThis.document;
    expect(properties['--tether-scrollbar-thumb']).toBe('#111');
    expect(properties['--tether-scrollbar-thumb-hover']).toBe('#222');
    expect(properties['--tether-scrollbar-track']).toBe('#333');
  });
});

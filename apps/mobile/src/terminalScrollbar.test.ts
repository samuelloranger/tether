import { describe, expect, test } from 'bun:test';
import { TERMINAL_SCROLLBAR_CSS } from './terminalScrollbar';

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
});

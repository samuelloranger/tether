import { expect, test } from 'bun:test';

const source = (name: string) => Bun.file(new URL(name, import.meta.url)).text();

test('terminal safe-area padding is inside the well, not wrapping App', async () => {
  const [app, screen, html, desktopView] = await Promise.all([
    Bun.file(new URL('../App.tsx', import.meta.url)).text(),
    source('./TerminalScreen.tsx'),
    source('./terminalRendererHtml.ts'),
    source('./TerminalView.tsx'),
  ]);

  // Outer App shell must not pad bottom/left/right around the terminal — that
  // drew bezel-colored gaps wrapping the PTY well.
  expect(app).not.toContain("edges={['bottom', 'left', 'right']}");
  expect(app).toContain(
    '<View style={[styles.appContainer, { backgroundColor: theme.colors.background }]}>',
  );

  // Well uses terminal.bg; horizontal safe-area gutters live on the terminal host.
  expect(screen).toContain('backgroundColor: theme.terminal.bg');
  expect(screen).toContain('paddingLeft: insets.left');
  expect(screen).toContain('paddingRight: insets.right');

  // 4px gutter is on .xterm (FitAddon-aware), not a wrapper around #terminal.
  expect(html).toContain('.xterm{box-sizing:border-box;padding:0 4px}');
  expect(html).not.toContain('#terminal{box-sizing:border-box;padding:0 4px}');
  expect(desktopView).toContain("terminal.element!.style.paddingLeft = '4px'");
  expect(desktopView).not.toContain('paddingLeft: 4');
});

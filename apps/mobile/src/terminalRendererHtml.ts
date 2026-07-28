import { TERMINAL_RENDERER_FONTS } from './terminalFonts.generated';
import { TERMINAL_RENDERER_BUNDLE, TERMINAL_RENDERER_CSS } from './terminalRenderer.generated';

export function terminalRendererHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
${TERMINAL_RENDERER_FONTS}
html,body,#terminal{width:100%;height:100%;margin:0;overflow:hidden;background:#1e1e2e}
#terminal{box-sizing:border-box;padding:0 4px}
${TERMINAL_RENDERER_CSS}
</style>
</head>
<body>
<div id="terminal"></div>
<script>${TERMINAL_RENDERER_BUNDLE}</script>
</body>
</html>`;
}

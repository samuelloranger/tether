// Matches ANY escape sequence: CSI (incl. private `<=>?` params), OSC, charset
// designation, or any other 2-byte ESC. Only SGR (`...m`) is styled; the rest
// (cursor moves, mode sets, keyboard protocol, etc.) are consumed and dropped.
const ANSI_REGEX =
  /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+#].|.)/g;
const SGR_REGEX = /^\x1b\[([0-9;]*)m$/;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Returns a CSS string for the given SGR codes, or '' for a reset.
function sgrToCss(codes: string): string {
  if (!codes || codes === '0') return '';
  let style = '';
  for (const part of codes.split(';')) {
    const code = parseInt(part, 10);
    if (isNaN(code)) continue;

    if (code === 1) style += 'font-weight: bold;';
    else if (code === 3) style += 'font-style: italic;';
    else if (code === 4) style += 'text-decoration: underline;';
    // Foreground standard colors
    else if (code >= 30 && code <= 37) {
      const colors = ['#1e1e24', '#f87171', '#34d399', '#fbbf24', '#60a5fa', '#c084fc', '#22d3ee', '#e5e7eb'];
      style += `color: ${colors[code - 30]};`;
    }
    // Foreground high-intensity colors
    else if (code >= 90 && code <= 97) {
      const colors = ['#9ca3af', '#ef4444', '#10b981', '#f59e0b', '#3b82f6', '#a855f7', '#06b6d4', '#ffffff'];
      style += `color: ${colors[code - 90]};`;
    }
    // Background standard colors
    else if (code >= 40 && code <= 47) {
      const bgColors = ['#111827', '#991b1b', '#065f46', '#92400e', '#1e40af', '#6b21a8', '#155e75', '#374151'];
      style += `background-color: ${bgColors[code - 40]};`;
    }
    // Background high-intensity colors
    else if (code >= 100 && code <= 107) {
      const bgColors = ['#4b5563', '#dc2626', '#16a34a', '#d97706', '#2563eb', '#9333ea', '#0891b2', '#9ca3af'];
      style += `background-color: ${bgColors[code - 100]};`;
    }
  }
  return style;
}

export function ansiToHtml(ansiStr: string): string {
  if (!ansiStr) return '';

  let out = '';
  let lastIndex = 0;
  let openSpan = false;
  let match: RegExpExecArray | null;
  ANSI_REGEX.lastIndex = 0;

  // Walk the raw string so escape sequences containing <, >, & aren't mangled
  // by HTML-escaping; escape only the surviving text chunks.
  while ((match = ANSI_REGEX.exec(ansiStr)) !== null) {
    out += escapeHtml(ansiStr.substring(lastIndex, match.index));

    const sgr = match[0].match(SGR_REGEX);
    if (sgr) {
      if (openSpan) {
        out += '</span>';
        openSpan = false;
      }
      const style = sgrToCss(sgr[1]);
      if (style) {
        out += `<span style="${style}">`;
        openSpan = true;
      }
    }
    // non-SGR sequences are dropped

    lastIndex = ANSI_REGEX.lastIndex;
  }

  out += escapeHtml(ansiStr.substring(lastIndex));
  if (openSpan) out += '</span>';

  // Normalize carriage returns and line feeds
  return out
    .replace(/\r\n/g, '<br/>')
    .replace(/\n/g, '<br/>')
    .replace(/\r/g, '');
}

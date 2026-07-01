export function ansiToHtml(ansiStr: string): string {
  if (!ansiStr) return '';
  
  // Escape HTML characters to prevent XSS
  let html = ansiStr
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Match: \x1b[...m
  const ansiRegex = /\x1b\[([0-9;]*)(m|K)/g;
  let openSpan = false;
  
  html = html.replace(ansiRegex, (match, codes, terminator) => {
    if (terminator === 'K') {
      // Clear line sequence - skip in simple HTML renderer
      return '';
    }
    
    if (!codes || codes === '0') {
      // Reset all styling
      let result = '';
      if (openSpan) {
        result += '</span>';
        openSpan = false;
      }
      return result;
    }
    
    const parts = codes.split(';');
    let style = '';
    
    for (let i = 0; i < parts.length; i++) {
      const code = parseInt(parts[i]);
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
    
    let result = '';
    if (openSpan) {
      result += '</span>';
    }
    if (style) {
      result += `<span style="${style}">`;
      openSpan = true;
    } else {
      openSpan = false;
    }
    return result;
  });
  
  if (openSpan) {
    html += '</span>';
  }
  
  // Normalize carriage returns and line feeds
  return html
    .replace(/\r\n/g, '<br/>')
    .replace(/\n/g, '<br/>')
    .replace(/\r/g, '');
}

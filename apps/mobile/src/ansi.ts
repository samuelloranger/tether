export interface TextSegment {
  text: string;
  style: {
    color?: string;
    fontWeight?: 'normal' | 'bold';
    fontStyle?: 'normal' | 'italic';
    textDecorationLine?: 'none' | 'underline';
    backgroundColor?: string;
  };
}

export function parseAnsi(ansiStr: string): TextSegment[] {
  if (!ansiStr) return [];

  // Match ANSI escape codes (e.g. \x1b[31;1m)
  const ansiRegex = /\x1b\[([0-9;]*)(m|K)/g;
  const segments: TextSegment[] = [];
  
  let lastIndex = 0;
  let currentStyle: TextSegment['style'] = {};
  
  let match;
  // Reset regex index
  ansiRegex.lastIndex = 0;
  
  while ((match = ansiRegex.exec(ansiStr)) !== null) {
    const textPart = ansiStr.substring(lastIndex, match.index);
    if (textPart) {
      segments.push({ text: textPart, style: { ...currentStyle } });
    }
    
    const codes = match[1];
    const terminator = match[2];
    
    if (terminator === 'm') {
      if (!codes || codes === '0') {
        currentStyle = {};
      } else {
        const parts = codes.split(';');
        for (const part of parts) {
          const code = parseInt(part);
          if (isNaN(code)) continue;
          
          if (code === 1) {
            currentStyle.fontWeight = 'bold';
          } else if (code === 3) {
            currentStyle.fontStyle = 'italic';
          } else if (code === 4) {
            currentStyle.textDecorationLine = 'underline';
          }
          // Foreground standard colors
          else if (code >= 30 && code <= 37) {
            const colors = ['#27272a', '#f87171', '#34d399', '#fbbf24', '#60a5fa', '#c084fc', '#22d3ee', '#e5e7eb'];
            currentStyle.color = colors[code - 30];
          } 
          // Foreground high-intensity colors
          else if (code >= 90 && code <= 97) {
            const colors = ['#9ca3af', '#ef4444', '#10b981', '#f59e0b', '#3b82f6', '#a855f7', '#06b6d4', '#ffffff'];
            currentStyle.color = colors[code - 90];
          }
          // Background standard colors
          else if (code >= 40 && code <= 47) {
            const bgColors = ['#18181b', '#991b1b', '#065f46', '#92400e', '#1e40af', '#6b21a8', '#155e75', '#374151'];
            currentStyle.backgroundColor = bgColors[code - 40];
          } 
          // Background high-intensity colors
          else if (code >= 100 && code <= 107) {
            const bgColors = ['#4b5563', '#dc2626', '#16a34a', '#d97706', '#2563eb', '#9333ea', '#0891b2', '#9ca3af'];
            currentStyle.backgroundColor = bgColors[code - 100];
          }
        }
      }
    }
    
    lastIndex = ansiRegex.lastIndex;
  }
  
  const remainingText = ansiStr.substring(lastIndex);
  if (remainingText) {
    segments.push({ text: remainingText, style: { ...currentStyle } });
  }
  
  return segments;
}

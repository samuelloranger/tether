import { useEffect, useRef } from 'react';
import { CodeHighlight } from './CodeHighlight';
import type { UiTheme } from './preferences';
import { type FileView, lineOffset } from './workspaceTypes';

export function FileViewer({
  file,
  onBack,
  theme,
  backLabel = 'Back to terminal',
}: {
  file: FileView;
  onBack: () => void;
  theme: UiTheme;
  backLabel?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = lineOffset(file.content, file.line);
    const root = scrollRef.current;
    if (!root) return;
    const row = root.querySelectorAll('.code-line')[target] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'start' });
  }, [file.content, file.line]);

  return (
    <div className="file-viewer">
      <header className="panel-header">
        <button type="button" className="secondary small" onClick={onBack} aria-label={backLabel}>
          ← {backLabel}
        </button>
        <span className="panel-header-title">{file.path}</span>
      </header>
      <div className="file-viewer-scroll" ref={scrollRef}>
        <CodeHighlight
          path={file.path}
          code={file.content}
          colors={{
            text: theme.colors.text,
            textMuted: theme.colors.textMuted,
            danger: theme.colors.danger,
            warning: theme.colors.warning,
            success: theme.colors.success,
            info: theme.colors.accent,
            accent: theme.colors.accent,
          }}
          foreground={theme.terminal.foreground}
        />
      </div>
    </div>
  );
}

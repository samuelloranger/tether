import type { Presentation } from '@/workspace/workspaceTypes';

export function PresentationBanner({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button type="button" className="presentation-banner" onClick={onPress} aria-label={label}>
      <span className="presentation-banner-text">{label}</span>
      <span className="muted" aria-hidden>
        →
      </span>
    </button>
  );
}

export function PresentationView({
  preview,
  html,
  backLabel,
  onBack,
  onClose,
}: {
  preview: Presentation;
  html: string;
  backLabel: string;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="presentation-view">
      <header className="panel-header">
        <button type="button" className="secondary small" onClick={onBack}>
          ← {backLabel}
        </button>
        <span className="panel-header-title">{preview.title}</span>
        <button type="button" className="danger small" onClick={onClose}>
          Close preview
        </button>
      </header>
      <iframe
        key={`${preview.id}:${preview.revision}`}
        className="presentation-frame"
        // sandbox WITHOUT allow-same-origin forces a unique opaque origin, so the
        // presented page cannot reach window.parent or the Tauri IPC bridge. Do
        // not add allow-same-origin — srcdoc would then inherit the app's origin.
        sandbox="allow-scripts"
        srcDoc={html}
        title={preview.title}
      />
    </div>
  );
}

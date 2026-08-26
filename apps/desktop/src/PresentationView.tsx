import type { Presentation } from './workspaceTypes';

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
  url,
  backLabel,
  onBack,
  onClose,
}: {
  preview: Presentation;
  url: string;
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
        src={url}
        title={preview.title}
      />
    </div>
  );
}

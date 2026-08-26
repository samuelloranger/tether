import { useEffect, useState } from 'react';
import { type AlertRequest, subscribeAlert } from './dialog';

export function AlertModal() {
  const [req, setReq] = useState<AlertRequest | null>(null);
  useEffect(() => subscribeAlert(setReq), []);
  if (!req) return null;

  const onDismiss = () => {
    if (req.kind === 'notify') req.resolve();
    else req.resolve(false);
  };

  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="Dismiss" onClick={onDismiss} />
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="alert-title">
        <h2 id="alert-title" className="modal-title">
          {req.title}
        </h2>
        <p className="modal-body">{req.body}</p>
        {req.kind === 'notify' ? (
          <div className="modal-actions">
            <button type="button" onClick={req.resolve}>
              OK
            </button>
          </div>
        ) : (
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => req.resolve(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={req.destructive ? 'destructive' : undefined}
              onClick={() => req.resolve(true)}
            >
              {req.confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function OverflowMenu({
  visible,
  onClose,
  onRename,
  onAppearance,
  notificationsEnabled,
  onToggleNotifications,
  onTestNotification,
  onCheckUpdates,
  onOpenSettings,
}: {
  visible: boolean;
  onClose: () => void;
  onRename: () => void;
  onAppearance: () => void;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  onTestNotification: () => void;
  onCheckUpdates: () => void;
  onOpenSettings: () => void;
}) {
  if (!visible) return null;
  return (
    <div className="modal-backdrop overflow-backdrop">
      <button type="button" className="modal-scrim" aria-label="Close menu" onClick={onClose} />
      <div className="overflow-panel" role="menu">
        <button type="button" className="overflow-row" role="menuitem" onClick={onRename}>
          Rename terminal
        </button>
        <button type="button" className="overflow-row" role="menuitem" onClick={onAppearance}>
          Appearance
        </button>
        <button
          type="button"
          className="overflow-row"
          role="menuitem"
          onClick={onToggleNotifications}
        >
          Notifications {notificationsEnabled ? 'on' : 'off'}
        </button>
        {notificationsEnabled ? (
          <button
            type="button"
            className="overflow-row"
            role="menuitem"
            onClick={onTestNotification}
          >
            Test notification
          </button>
        ) : null}
        <button type="button" className="overflow-row" role="menuitem" onClick={onCheckUpdates}>
          Check for updates
        </button>
        <button type="button" className="overflow-row" role="menuitem" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </div>
  );
}

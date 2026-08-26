import { sendOsNotification } from './desktopNotifications';
import { checkForUpdates } from './desktopUpdater';
import { OverflowMenu } from './OverflowMenu';
import { type AppPreferences, savePreferences } from './preferences';

/**
 * The overflow menu's wiring, lifted out of `App` so the shell stays readable.
 *
 * Every item except the notifications toggle dismisses the menu first: the
 * toggle is the one action whose result you read *in* the menu, since the row's
 * own label is what changes.
 */
export function AppOverflowMenu({
  visible,
  align,
  onClose,
  prefs,
  onPrefsChange,
  onRename,
  onAppearance,
  onOpenServerSettings,
}: {
  visible: boolean;
  align: 'start' | 'end';
  onClose: () => void;
  prefs: AppPreferences;
  onPrefsChange: (next: AppPreferences) => void;
  onRename: () => void;
  onAppearance: () => void;
  onOpenServerSettings: () => void;
}) {
  const dismissing = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <OverflowMenu
      visible={visible}
      align={align}
      onClose={onClose}
      onRename={dismissing(onRename)}
      onAppearance={dismissing(onAppearance)}
      notificationsEnabled={prefs.notificationsEnabled}
      onToggleNotifications={() => {
        const next = { ...prefs, notificationsEnabled: !prefs.notificationsEnabled };
        savePreferences(next);
        onPrefsChange(next);
      }}
      onTestNotification={dismissing(() => {
        void sendOsNotification('Tether', 'Test notification');
      })}
      onCheckUpdates={dismissing(() => {
        void checkForUpdates();
      })}
      onOpenSettings={dismissing(onOpenServerSettings)}
    />
  );
}

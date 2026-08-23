import type {
  EventSubscription,
  MaybeNotificationResponse,
  NotificationResponse,
} from 'expo-notifications';

// expo-notifications has no web implementation of the notification-response
// API. `useLastNotificationResponse` calls the native `getLastNotificationResponse`
// from a layout effect, and the emitter module doesn't define it on web, so it
// throws UnavailabilityError during React's commit phase — which unmounted the
// tree and brought the desktop app up as a blank white window (v2.8.0 onward,
// when the push deep-link path landed).
//
// Nothing is lost by stubbing it: push is registered on iOS only (see
// usePushRegistration), and desktop deep links arrive through
// @tauri-apps/plugin-deep-link, which useDeepLinks wires up separately.
export function useLastNotificationResponse(): MaybeNotificationResponse {
  return null;
}

export function addNotificationResponseReceivedListener(
  _listener: (event: NotificationResponse) => void,
): EventSubscription {
  return { remove: () => {} };
}

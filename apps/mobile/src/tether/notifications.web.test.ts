import { describe, expect, test } from 'bun:test';
import {
  addNotificationResponseReceivedListener,
  useLastNotificationResponse,
} from './notifications.web';

// The desktop shell runs the web bundle, where expo-notifications has no
// notification-response implementation. Calling the real hook there threw
// UnavailabilityError out of a layout effect and blanked the whole window, so
// these stubs must stay inert — never reaching into expo-notifications.
describe('notifications.web', () => {
  test('useLastNotificationResponse reports no response instead of throwing', () => {
    expect(useLastNotificationResponse()).toBeNull();
  });

  test('addNotificationResponseReceivedListener hands back a removable no-op subscription', () => {
    const subscription = addNotificationResponseReceivedListener(() => {
      throw new Error('the web stub must never deliver a notification response');
    });
    expect(() => subscription.remove()).not.toThrow();
  });
});

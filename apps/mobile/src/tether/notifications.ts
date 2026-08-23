// The notification-response half of expo-notifications, behind a module the
// desktop build can swap out — see notifications.web.ts for why.
export {
  addNotificationResponseReceivedListener,
  useLastNotificationResponse,
} from 'expo-notifications';

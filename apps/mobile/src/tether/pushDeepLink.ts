// Tapping a native push does NOT emit a Linking URL — iOS delivers a
// notification response instead, so the `link` the server put in the payload is
// invisible to the app's existing deep-link listeners unless it is pulled out
// of the response and fed in by hand.

export interface NotificationResponseLike {
  notification?: {
    request?: {
      content?: {
        data?: Record<string, unknown> | null;
      } | null;
    } | null;
  } | null;
}

/**
 * Extract the tether:// link from a notification response.
 *
 * The link travels in the APNs payload for cleartext pushes and is written into
 * userInfo by the Notification Service Extension for encrypted ones, so both
 * paths arrive at the same `data.link`.
 */
export function linkFromNotificationResponse(
  response: NotificationResponseLike | null | undefined,
): string | null {
  const link = response?.notification?.request?.content?.data?.link;
  if (typeof link !== 'string' || link.length === 0) return null;
  // Only ever hand our own scheme to the deep-link handler; a payload is
  // attacker-influenced if a host is compromised, and this is the one place it
  // would reach navigation.
  return link.startsWith('tether://') ? link : null;
}

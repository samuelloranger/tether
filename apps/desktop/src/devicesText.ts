// Pure presentation helpers for DevicesScreen, kept testable without rendering.
// Mirrors iOS DevicesView's `shortFingerprint` / `lastSeenText`.

/** Enough of a fingerprint to eyeball; matches the iOS client's 23-char prefix. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 23);
}

export function lastSeenText(device: {
  lastSeenAt: string | null;
  lastAddress: string | null;
}): string {
  if (!device.lastSeenAt) return 'Never connected';
  if (device.lastAddress) return `Last seen ${device.lastSeenAt} · ${device.lastAddress}`;
  return `Last seen ${device.lastSeenAt}`;
}

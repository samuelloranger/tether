// Pure presentation helpers for DevicesScreen — kept out of the component so the
// row formatting is unit-testable without rendering. Mirrors the iOS
// DevicesView helpers (`shortFingerprint` / `lastSeenText`).

/**
 * The first grouped chunk of a fingerprint — enough to eyeball, short enough for
 * a row. Keeps the host's grouping (space- or colon-separated) if present, and
 * matches the iOS client's 23-char prefix.
 */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 23);
}

/**
 * The "last seen" line: never-connected devices say so; otherwise show the
 * timestamp, with the last address appended when the server reported one.
 */
export function lastSeenText(device: {
  lastSeenAt: string | null;
  lastAddress: string | null;
}): string {
  if (!device.lastSeenAt) return 'Never connected';
  if (device.lastAddress) return `Last seen ${device.lastSeenAt} · ${device.lastAddress}`;
  return `Last seen ${device.lastSeenAt}`;
}

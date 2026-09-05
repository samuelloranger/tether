// Same 64-char hex sha256 a host prints as "Server fingerprint"; grouped into
// 4-char blocks (matching the iOS client) so it can be read out loud.
export function groupFingerprint(hex: string): string {
  return (hex.match(/.{1,4}/g) ?? [hex]).join(' ');
}

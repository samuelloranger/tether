// A fingerprint is a 64-char hex sha256 — the SAME string a host prints as its
// "Server fingerprint", and the shape `core_noise_device_fingerprint` returns
// for this device. Group it into 4-char blocks (matching the iOS client) so it
// can be read and compared out loud against the host.
export function groupFingerprint(hex: string): string {
  return (hex.match(/.{1,4}/g) ?? [hex]).join(' ');
}

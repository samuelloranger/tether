/**
 * Pick the rate-limit key from X-Forwarded-For.
 *
 * XFF is "client, proxy1, proxy2…": each proxy APPENDS the address it received
 * the request from. Everything to the left of our own trusted hops is
 * attacker-supplied — a caller can send `X-Forwarded-For: 1.2.3.4` and our
 * proxy will simply append the real address after it. Trusting the leftmost
 * entry therefore lets anyone rotate the header and bypass the limiter
 * entirely, so we count from the RIGHT instead.
 *
 * `trustedHops` is how many proxies sit in front of the relay (1 for a single
 * reverse proxy). The entry that proxy appended is the real peer.
 */
export function clientIpFromForwarded(
  forwardedFor: string | undefined,
  trustedHops: number,
): string {
  if (!forwardedFor) return 'direct';
  const parts = forwardedFor
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'direct';
  // With N trusted hops the peer address is N-th from the end.
  const index = parts.length - Math.max(1, trustedHops);
  return parts[Math.max(0, index)] ?? 'direct';
}

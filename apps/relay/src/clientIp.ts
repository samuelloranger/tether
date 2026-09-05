/**
 * Rate-limit key from X-Forwarded-For. Each proxy APPENDS the peer it saw, so anything
 * left of our `trustedHops` is attacker-supplied — count from the RIGHT for the real peer.
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

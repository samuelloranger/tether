/** Most-recently-active session keys, front = newest. Drives which non-visible
 * sessions stay resident. Bounded so the history can't grow without limit. */
export function touchLru(order: string[], key: string, max = 64): string[] {
  return [key, ...order.filter((k) => k !== key)].slice(0, max);
}

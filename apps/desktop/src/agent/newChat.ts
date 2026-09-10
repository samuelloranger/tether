/** Next free `agent-N` id among a host's existing session ids. Mirrors iOS
 * nextAgentSessionId — agent chats get their own id namespace, distinct from
 * the terminal `term-N` ids. */
export function nextAgentSessionId(existingIds: string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^agent-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `agent-${max + 1}`;
}

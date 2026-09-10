import type { AgentMessage } from './agentTypes';

function messageText(m: AgentMessage): string {
  return m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** Plain-text transcript for the clipboard. `last` copies only the newest
 * assistant reply; anything else copies the whole conversation. */
export function transcriptText(messages: AgentMessage[], mode: string): string {
  if (mode === 'last') {
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    return last ? messageText(last) : '';
  }
  return messages
    .map((m) => `${m.role === 'user' ? 'You' : 'Claude'}: ${messageText(m)}`)
    .join('\n\n');
}

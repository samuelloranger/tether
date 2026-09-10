export interface AgentCommand {
  id: string;
  trigger: string;
  kind: 'local' | 'agent';
  args?: string;
  glyph: string;
  desc: string;
}

export type DispatchResult =
  | { type: 'local'; id: string; args: string }
  | { type: 'agentText'; text: string }
  | { type: 'none' };

export const AGENT_COMMANDS: AgentCommand[] = [
  { id: 'clear', trigger: '/clear', kind: 'local', glyph: '⌫', desc: 'Start a fresh conversation' },
  {
    id: 'copy',
    trigger: '/copy',
    kind: 'local',
    args: '[last|all]',
    glyph: '⧉',
    desc: 'Copy the transcript to clipboard',
  },
  { id: 'retry', trigger: '/retry', kind: 'local', glyph: '↻', desc: 'Resend the last prompt' },
  {
    id: 'model',
    trigger: '/model',
    kind: 'local',
    glyph: '◎',
    desc: 'Switch the model for this session',
  },
  {
    id: 'resume',
    trigger: '/resume',
    kind: 'local',
    glyph: '⟲',
    desc: 'Reopen a past session in a new tab',
  },
  {
    id: 'compact',
    trigger: '/compact',
    kind: 'agent',
    glyph: '⊘',
    desc: 'Summarize context to free tokens',
  },
  {
    id: 'init',
    trigger: '/init',
    kind: 'agent',
    glyph: '✦',
    desc: 'Generate a CLAUDE.md for this repo',
  },
  {
    id: 'review',
    trigger: '/review',
    kind: 'agent',
    args: '[target]',
    glyph: '▤',
    desc: 'Review the current diff',
  },
  {
    id: 'commit',
    trigger: '/commit',
    kind: 'agent',
    args: '[msg]',
    glyph: '✎',
    desc: 'Stage and commit changes',
  },
];

const byId = new Map(AGENT_COMMANDS.map((c) => [c.id, c]));

/** Palette is active only while the draft is a single `/word` with no space. */
export function matchCommands(draft: string): AgentCommand[] {
  if (!draft.startsWith('/') || draft.includes(' ')) return [];
  const q = draft.slice(1).toLowerCase();
  if (q === '') return AGENT_COMMANDS;
  return AGENT_COMMANDS.filter((c) => c.id.includes(q));
}

export function dispatchDraft(draft: string): DispatchResult {
  if (!draft.startsWith('/')) return { type: 'none' };
  const [head, ...rest] = draft.slice(1).split(' ');
  const cmd = byId.get(head);
  if (cmd?.kind === 'local') return { type: 'local', id: cmd.id, args: rest.join(' ') };
  return { type: 'agentText', text: draft };
}

export type AgentRole = 'user' | 'assistant' | 'error';
export type AgentTurn = 'idle' | 'thinking' | 'streaming';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
}

export interface DiffHunk {
  lines: DiffLine[];
}

export interface DerivedDiff {
  path: string;
  hunks: DiffHunk[];
}

export interface AgentToolCall {
  id: string;
  name: string;
  summary: string;
  inputJson: string;
  result?: string;
  isError: boolean;
  diff?: DerivedDiff;
}

export type AgentBlock = { type: 'text'; text: string } | { type: 'tool'; tool: AgentToolCall };

export interface AgentMessage {
  id: string;
  role: AgentRole;
  blocks: AgentBlock[];
  isStreaming: boolean;
  usage?: AgentUsage;
}

/** Semantic colour category for a tool card; the CSS maps it to a token. */
export type AgentToolAccent = 'success' | 'accent' | 'muted' | 'info';

export interface AgentToolStyle {
  accent: AgentToolAccent;
  glyph: string;
}

/**
 * Tool identity → card colour + glyph. Port of Swift AgentToolStyle
 * (AgentMessage.swift:105). Bash is loud (runs commands), edits are accent,
 * reads/searches are quiet, web is info.
 */
export function toolStyle(name: string): AgentToolStyle {
  switch (name.toLowerCase()) {
    case 'bash':
    case 'shell':
      return { accent: 'success', glyph: '$' };
    case 'edit':
    case 'write':
    case 'multiedit':
    case 'notebookedit':
      return { accent: 'accent', glyph: '✎' };
    case 'read':
      return { accent: 'muted', glyph: '▤' };
    case 'glob':
    case 'grep':
    case 'ls':
      return { accent: 'muted', glyph: '⌕' };
    case 'webfetch':
    case 'websearch':
      return { accent: 'info', glyph: '◍' };
    default:
      return { accent: 'muted', glyph: '⚙' };
  }
}

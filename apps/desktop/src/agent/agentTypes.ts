export type AgentRole = 'user' | 'assistant' | 'error';
export type AgentTurn = 'idle' | 'thinking' | 'streaming';

/** One rate-limit window from the account usage endpoint. */
export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

/** Ephemeral account/session status shown in the chat's info strip. */
export interface AgentStatus {
  model: string | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** Compact token count: 1.2k past a thousand, else the raw integer. Matches
 * iOS `usageFooter` (AgentChatView.swift:328). */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Cost with cent-precision, or four decimals under a cent. Matches iOS
 * `money` (AgentChatView.swift:332). */
export function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
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

/** One past Claude Code session offered in the /resume picker (mirror of the
 * server's ClaudeSessionMeta). */
export interface ClaudeSessionMeta {
  id: string;
  label: string;
  mtimeMs: number;
  msgCount: number;
  cwd: string;
}

import type { TerminalSocket } from '../wsTransport';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'auth-failed';

export interface TerminalConnectionState {
  sock: TerminalSocket | null;
  gen: number;
  open: boolean;
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  retry: number;
  ping: ReturnType<typeof setInterval> | null;
  lastSeen: number;
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

import type { TerminalSocket } from '../wsTransport';
import type { HostClient } from './hostClient';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'auth-failed';

export interface TerminalConnectionState {
  client: HostClient;
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

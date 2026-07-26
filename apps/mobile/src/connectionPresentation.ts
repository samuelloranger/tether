export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'auth-failed';

export type ConnectionPresentation = {
  label: string;
  tone: 'danger' | 'warning';
};

export function connectionPresentation(
  status: ConnectionStatus,
  hasConnected: boolean,
): ConnectionPresentation {
  if (status === 'auth-failed') return { label: 'Wrong password.', tone: 'danger' };
  if (hasConnected) {
    return { label: 'Reconnecting… (session kept running on the server)', tone: 'warning' };
  }
  return { label: 'Connecting…', tone: 'warning' };
}

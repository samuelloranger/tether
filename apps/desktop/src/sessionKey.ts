export function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

export function parseSessionKey(key: string): { hostId: string; sessionId: string } {
  const separator = key.indexOf(':');
  if (separator < 1 || separator === key.length - 1) {
    throw new Error(`Invalid session key: ${key}`);
  }
  return { hostId: key.slice(0, separator), sessionId: key.slice(separator + 1) };
}

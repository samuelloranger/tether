/** Thin timestamped wrappers over console — daemon logs land in ~/.tether/server.log. */

function prefix(message: string): string {
  return `${new Date().toISOString()} ${message}`;
}

export function logInfo(message: string, ...args: unknown[]): void {
  console.log(prefix(message), ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
  console.warn(prefix(message), ...args);
}

export function logError(message: string, ...args: unknown[]): void {
  console.error(prefix(message), ...args);
}

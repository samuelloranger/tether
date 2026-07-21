export function validateAddress(
  host: string,
  port: string,
): { ok: true } | { ok: false; reason: string } {
  if (!host.trim()) return { ok: false, reason: 'Enter a server host or IP.' };
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return { ok: false, reason: 'Port must be between 1 and 65535.' };
  }
  return { ok: true };
}

export function httpBase(host: string, port: string): string {
  return `http://${host}:${port}`;
}

export function wsUrl(host: string, port: string, params: Record<string, string | number>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `ws://${host}:${port}/api/ws?${qs}`;
}

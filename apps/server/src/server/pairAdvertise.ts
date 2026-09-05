import { networkInterfaces } from 'node:os';
import { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT, type TlsMode } from './tlsConfig';

export function firstNonLoopbackIPv4(): string[] {
  const hosts: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) hosts.push(addr.address);
    }
  }
  return hosts;
}

export function advertisePairUrl(opts: {
  mode: TlsMode;
  httpPort: number | null;
  httpsPort: number | null;
  hosts: string[];
}): string | null {
  if (opts.hosts.length === 0) return null;
  const host = opts.hosts[0];
  if (opts.mode === 'only') {
    const port = opts.httpsPort ?? DEFAULT_HTTPS_PORT;
    return `https://${host}:${port}`;
  }
  const port = opts.httpPort ?? DEFAULT_HTTP_PORT;
  return `http://${host}:${port}`;
}

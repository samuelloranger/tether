import { Hono } from 'hono';
import { type Config, getConfig, getShellSupport, patchConfig } from '../config';
import { countPushDevices } from '../pushDevices';
import { getTlsReport } from '../tlsRuntime';

// pushDevices and tls are reported alongside the config but are derived state,
// not settings: a client that could patch tls off would lock out other clients.
const withDerived = (config: Config) => ({
  ...config,
  pushDevices: countPushDevices(),
  tls: getTlsReport(),
  // Read-only verdict on session.defaultShell: a client may set it to anything,
  // and a Windows MSYS bash silently disables git/file-tree/upload features.
  shell: getShellSupport(),
});

export const configRoutes = new Hono();

configRoutes.get('/api/config', (c) => c.json(withDerived(getConfig())));
configRoutes.patch('/api/config', async (c) => {
  try {
    return c.json(withDerived(await patchConfig(await c.req.json())));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'invalid config' }, 400);
  }
});

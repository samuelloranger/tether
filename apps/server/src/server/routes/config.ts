import { Hono } from 'hono';
import { type Config, getConfig, getShellSupport, patchConfig } from '../config';
import { countPushDevices } from '../pushDevices';
import { getTlsReport } from '../tlsRuntime';

// `pushDevices` is reported alongside the config but is not part of it: the
// client needs it to explain why notifications are silent (nothing registered
// yet), and it is derived state, not a setting anyone can PATCH.
//
// `tls` is here for the same reason and with a sharper edge: the client needs to
// show the user whether the wire is encrypted, but the listener topology is host
// configuration (see tlsConfig.ts) precisely because a client that could turn it
// off would lock out every other client. Reported, never patchable.
const withDerived = (config: Config) => ({
  ...config,
  pushDevices: countPushDevices(),
  tls: getTlsReport(),
  // Read-only verdict on the shell `session.defaultShell` currently names. A
  // client may set that field to anything, and on Windows one of those anythings
  // (an MSYS/Git-for-Windows bash) reports /c/Users paths that silently disable
  // the git, file-tree and upload features. The choice is not rejected — this is
  // how a client can explain what it costs.
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

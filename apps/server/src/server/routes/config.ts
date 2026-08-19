import { Hono } from 'hono';
import { type Config, getConfig, patchConfig } from '../config';
import { countPushDevices } from '../pushDevices';

export const configRoutes = new Hono();

// `pushDevices` is reported alongside the config but is not part of it: the
// client needs it to explain why notifications are silent (nothing registered
// yet), and it is derived state, not a setting anyone can PATCH.
const withPushDevices = (config: Config) => ({ ...config, pushDevices: countPushDevices() });

configRoutes.get('/api/config', (c) => c.json(withPushDevices(getConfig())));
configRoutes.patch('/api/config', async (c) => {
  try {
    return c.json(withPushDevices(await patchConfig(await c.req.json())));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'invalid config' }, 400);
  }
});

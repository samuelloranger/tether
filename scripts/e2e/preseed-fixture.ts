// Mints a device keypair with the SAME cdylib crypto the app core uses, enrolls
// its public key in the running server's device registry, and prints a JSON
// fixture the XCUITest injects via TETHER_UITEST_PRESEED so the app launches
// already paired. Run with TETHER_DB_PATH pointing at the server's DB so the
// enrollment and server keypair match the server under test.
//
//   TETHER_DB_PATH=~/.tether-e2e/tether.db bun scripts/e2e/preseed-fixture.ts
import { upsertDevice } from '../../apps/server/src/deviceRegistry';
import { genKeypair } from '../../apps/server/src/noiseFfi';
import { loadOrCreateServerKeypair } from '../../apps/server/src/noiseIdentity';

const host = process.env.FIX_HOST ?? '127.0.0.1';
const port = process.env.FIX_PORT ?? '8085';
const scheme = process.env.FIX_SCHEME ?? 'ws';
const name = process.env.FIX_NAME ?? 'e2e';

const device = genKeypair();
const server = loadOrCreateServerKeypair();

const devicePubB64 = Buffer.from(device.pub).toString('base64');
upsertDevice({ label: 'e2e-uitest', pubkey: devicePubB64, address: `${host}:${port}` });

process.stdout.write(
  `${JSON.stringify({
    name,
    host,
    port,
    scheme,
    devicePrivB64: Buffer.from(device.priv).toString('base64'),
    serverPubB64: Buffer.from(server.pub).toString('base64'),
  })}\n`,
);

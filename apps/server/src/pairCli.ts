import * as readline from 'node:readline/promises';
import { pairQrPayload, renderPairQr } from '@/auth/pairQr';

export function groupPairCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

export interface PairDeps {
  // The daemon's loopback control socket (~/.tether/control.sock).
  sock: string;
  advertiseUrl?: string | null;
  qr?: (payload: string) => Promise<string>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  log?: (message: string) => void;
  readLine?: (prompt: string) => Promise<string>;
}

interface PendingDevice {
  label: string;
  pubkeyBase64: string;
  fingerprint: string;
}

function defaultReadLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(prompt).finally(() => rl.close());
}

function isApproved(answer: string): boolean {
  const trimmed = answer.trim().toLowerCase();
  return trimmed === 'y' || trimmed === 'yes';
}

function controlRequest(deps: PairDeps, path: string, init: RequestInit = {}): Promise<Response> {
  return (deps.fetch ?? fetch)(`http://localhost${path}`, {
    ...init,
    unix: deps.sock,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  } as RequestInit);
}

async function requireOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`Tether ${what} failed (${res.status}). Is tether running?`);
  return res;
}

async function waitForPending(deps: PairDeps): Promise<PendingDevice> {
  for (;;) {
    const res = await requireOk(await controlRequest(deps, '/control/pair/pending'), 'pair');
    const body = (await res.json()) as { pending: PendingDevice | null };
    if (body.pending) return body.pending;
  }
}

export async function runPair(deps: PairDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const readLine = deps.readLine ?? defaultReadLine;
  let opened = false;
  try {
    const openedRes = await requireOk(
      await controlRequest(deps, '/control/pair/open', { method: 'POST' }),
      'pair',
    );
    opened = true;
    const { code, fingerprint } = (await openedRes.json()) as {
      code: string;
      fingerprint: string;
    };
    log(`Pairing code: ${groupPairCode(code)}`);
    log('Enter this code on the device.');
    log(`Server fingerprint: ${fingerprint}`);

    if (deps.advertiseUrl !== undefined) {
      if (deps.advertiseUrl === null) {
        console.error('No non-loopback IPv4; scan skipped — type the code.');
      } else {
        log(deps.advertiseUrl);
        const qr = deps.qr ?? renderPairQr;
        log(await qr(pairQrPayload(code, deps.advertiseUrl)));
      }
    }

    const pending = await waitForPending(deps);
    log(`Device '${pending.label}'  fp ${pending.fingerprint}`);
    const approve = isApproved(await readLine('Authorize? [y/N] '));
    const confirmRes = await requireOk(
      await controlRequest(deps, '/control/pair/confirm', {
        method: 'POST',
        body: JSON.stringify({ approve }),
      }),
      'pair',
    );
    const outcome = (await confirmRes.json()) as { approved: boolean };
    log(outcome.approved ? 'Device approved.' : 'Device rejected.');
  } finally {
    if (opened) {
      await controlRequest(deps, '/control/pair/close', { method: 'POST' }).catch(() => {});
    }
  }
}

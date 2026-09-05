import { type Context, Hono } from 'hono';
import { upsertDevice as registryAddDevice } from './deviceRegistry';
import { EnrollmentWindow, type PairingDeps, runPairing } from './enrollment';
import type { FrameIO } from './noiseChannel';
import { loadOrCreateServerKeypair, serverFingerprint } from './noiseIdentity';
import { hasControlToken } from './routes/presentations';

export interface PendingProposal {
  label: string;
  pubkeyBase64: string;
  fingerprint: string;
}

export interface PairControlDeps {
  window?: EnrollmentWindow;
  addDevice?: PairingDeps['addDevice'];
  loadKeypair?: () => { pub: Uint8Array; priv: Uint8Array };
  label?: string;
  address?: string;
  /** How long GET /control/pair/pending waits for a proposal. 0 = return immediately. */
  pendingTimeoutMs?: number;
}

interface PendingSlot extends PendingProposal {
  resolve: (approve: boolean) => void;
}

export interface PairControl {
  open(): { code: string; expiresAt: number; fingerprint: string };
  close(): void;
  getPending(): PendingProposal | null;
  waitPending(timeoutMs: number): Promise<PendingProposal | null>;
  confirm(approve: boolean): boolean;
  handlePairingConnection(
    io: FrameIO,
    opts?: { label?: string; address?: string },
  ): Promise<{ pubkey: string }>;
  routes: Hono;
}

function createPendingGate() {
  let pending: PendingSlot | null = null;
  const waiters = new Set<() => void>();

  function snapshot(): PendingProposal | null {
    if (!pending) return null;
    return {
      label: pending.label,
      pubkeyBase64: pending.pubkeyBase64,
      fingerprint: pending.fingerprint,
    };
  }

  function wake(): void {
    for (const w of waiters) w();
    waiters.clear();
  }

  return {
    snapshot,
    waitPending(timeoutMs: number): Promise<PendingProposal | null> {
      const existing = snapshot();
      if (existing || timeoutMs <= 0) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(onWake);
          resolve(snapshot());
        }, timeoutMs);
        const onWake = () => {
          clearTimeout(timer);
          waiters.delete(onWake);
          resolve(snapshot());
        };
        waiters.add(onWake);
      });
    },
    confirm(approve: boolean): boolean {
      if (!pending) return false;
      const slot = pending;
      pending = null;
      slot.resolve(approve);
      return true;
    },
    park(proposal: PendingProposal): Promise<boolean> {
      if (pending) return Promise.resolve(false);
      return new Promise((resolve) => {
        pending = { ...proposal, resolve };
        wake();
      });
    },
    reject(): void {
      if (!pending) return;
      const slot = pending;
      pending = null;
      slot.resolve(false);
      wake();
    },
  };
}

function gated(c: Context, then: () => Response | Promise<Response>): Response | Promise<Response> {
  if (!hasControlToken(c.req.header('X-Tether-Present-Control'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return then();
}

function createPairRoutes(
  control: Pick<PairControl, 'open' | 'close' | 'waitPending' | 'confirm'>,
  pendingTimeoutMs: number,
): Hono {
  const routes = new Hono();
  routes.post('/control/pair/open', (c) => gated(c, () => c.json(control.open())));
  routes.get('/control/pair/pending', (c) =>
    gated(c, async () => c.json({ pending: await control.waitPending(pendingTimeoutMs) })),
  );
  routes.post('/control/pair/confirm', (c) =>
    gated(c, async () => {
      const body = await c.req.json().catch(() => ({}));
      if (typeof body.approve !== 'boolean') return c.json({ error: 'missing approve' }, 400);
      if (!control.confirm(body.approve)) return c.json({ error: 'nothing pending' }, 409);
      return c.json({ approved: body.approve });
    }),
  );
  routes.post('/control/pair/close', (c) =>
    gated(c, () => {
      control.close();
      return c.json({ ok: true });
    }),
  );
  return routes;
}

export function createPairControl(deps: PairControlDeps = {}): PairControl {
  const window = deps.window ?? new EnrollmentWindow();
  const addDevice = deps.addDevice ?? registryAddDevice;
  const loadKeypair = deps.loadKeypair ?? loadOrCreateServerKeypair;
  const defaultLabel = deps.label ?? 'device';
  const defaultAddress = deps.address;
  const pendingTimeoutMs = deps.pendingTimeoutMs ?? 1500;
  const gate = createPendingGate();

  function open(): { code: string; expiresAt: number; fingerprint: string } {
    const { code, expiresAt } = window.open();
    return { code, expiresAt, fingerprint: serverFingerprint(loadKeypair().pub) };
  }

  function close(): void {
    window.close();
    gate.reject();
  }

  async function handlePairingConnection(
    io: FrameIO,
    opts?: { label?: string; address?: string },
  ): Promise<{ pubkey: string }> {
    const label = opts?.label ?? defaultLabel;
    return runPairing(io, loadKeypair().priv, window, {
      addDevice,
      label,
      address: opts?.address ?? defaultAddress,
      confirm: (proposal) => gate.park({ ...proposal, label }),
    });
  }

  return {
    open,
    close,
    getPending: gate.snapshot,
    waitPending: gate.waitPending,
    confirm: gate.confirm,
    handlePairingConnection,
    routes: createPairRoutes(
      { open, close, waitPending: gate.waitPending, confirm: gate.confirm },
      pendingTimeoutMs,
    ),
  };
}

export const pairControl = createPairControl();
export const pairControlRoutes = pairControl.routes;
export const handlePairingConnection = (
  io: FrameIO,
  opts?: { label?: string; address?: string },
): Promise<{ pubkey: string }> => pairControl.handlePairingConnection(io, opts);

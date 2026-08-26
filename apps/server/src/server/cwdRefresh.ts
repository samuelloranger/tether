import type { HolderDialect } from './holderFrame';

/**
 * After a CWDREQ times out, skip further asks for this long.
 *
 * Five seconds is long enough that a silent/broken holder does not tax every
 * git or file request with another 250ms wait, and short enough that a holder
 * which recovers (or was merely busy) is asked again within one human
 * interaction cycle — without restarting the session.
 *
 * Legacy holders never reach this path: `dialect === 'legacy'` is rejected
 * before any request is sent, so the cooldown is only for transient silence
 * on a negotiated binary link.
 */
export const CWD_REFRESH_COOLDOWN_MS = 5_000;

export type CwdRefreshPlan = 'skip' | 'join' | 'start';

export type CwdRefreshContext = {
  hasLink: boolean;
  exited: boolean;
  dialect: HolderDialect | null;
  /** Epoch ms until which further CWDREQs are skipped; null = not cooling down. */
  cooldownUntil: number | null;
  /** Callers already waiting on an outstanding CWDREQ. */
  waiterCount: number;
  now: number;
};

/**
 * Decide whether `refreshLiveCwd` should return immediately, share an in-flight
 * wait, or send a new CWDREQ. Pure so the cooldown / coalesce rules can be
 * tested without a holder socket.
 */
export function planCwdRefresh(ctx: CwdRefreshContext): CwdRefreshPlan {
  if (!ctx.hasLink || ctx.exited) return 'skip';
  // Pre-v2 holders cannot express CWDREQ; asking would only burn the timeout.
  if (ctx.dialect === 'legacy') return 'skip';
  if (ctx.waiterCount > 0) return 'join';
  if (ctx.cooldownUntil !== null && ctx.now < ctx.cooldownUntil) return 'skip';
  return 'start';
}

export function cooldownUntilAfterTimeout(
  now: number,
  cooldownMs = CWD_REFRESH_COOLDOWN_MS,
): number {
  return now + cooldownMs;
}

/**
 * Shared waiters + cooldown for one holder link. Timers stay in the caller;
 * this only owns who is waiting and when the next ask is allowed.
 */
export class CwdRefreshGate {
  cooldownUntil: number | null = null;
  private waiters: Array<(ok: boolean) => void> = [];

  get waiterCount(): number {
    return this.waiters.length;
  }

  plan(ctx: Omit<CwdRefreshContext, 'cooldownUntil' | 'waiterCount'>): CwdRefreshPlan {
    return planCwdRefresh({
      ...ctx,
      cooldownUntil: this.cooldownUntil,
      waiterCount: this.waiters.length,
    });
  }

  /** Promise that settles when `settle` runs (answer or timeout). */
  wait(): Promise<boolean> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** CWD arrived — clear any cooldown and wake every waiter. */
  onAnswer(ok: boolean): void {
    if (ok) this.cooldownUntil = null;
    this.settle(ok);
  }

  /** Request timed out — arm the cooldown, then wake every waiter as false. */
  onTimeout(now: number, cooldownMs = CWD_REFRESH_COOLDOWN_MS): void {
    this.cooldownUntil = cooldownUntilAfterTimeout(now, cooldownMs);
    this.settle(false);
  }

  private settle(ok: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(ok);
  }
}

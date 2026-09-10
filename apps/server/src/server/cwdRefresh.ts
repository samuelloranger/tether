import type { HolderDialect } from './holderFrame';

/**
 * After a CWDREQ times out, skip further asks for this long — long enough to spare
 * a broken holder repeated 250ms waits, short enough to retry within a human interaction.
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
 * Decide whether `refreshLiveCwd` returns immediately, shares an in-flight wait, or
 * sends a new CWDREQ. Pure so cooldown/coalesce rules are testable without a holder socket.
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

import { getSession } from './db';
import { broadcast, notify } from './ptyHolder';
import { recordSignal, type SignalState } from './sessionActivity';

/**
 * A program declaring its own state, arriving from `/control/signal`.
 *
 * The same three things an output-driven transition does: record it, tell the
 * attached clients, and raise a notification. Unlike the output path this is
 * not a guess, so `waiting` here means genuinely blocked and `done` means
 * genuinely finished — which is why the two have separate triggers.
 *
 * The session lookup comes FIRST and gates everything. `recordSignal` creates
 * per-session state for whatever id it is handed, so signalling a typo would
 * otherwise leak a map entry that nothing ever clears.
 *
 * Lives outside `ptyHolder.ts` because that file is at the Biome line limit;
 * behaviour is otherwise identical to putting it there.
 */
export function signalSession(
  id: string,
  state: SignalState,
  words?: { title?: string; body?: string },
): boolean {
  if (!getSession(id)) return false;
  const activity = recordSignal(id, state);
  if (activity) broadcast(id, { type: 'activity', activity });
  if (state === 'waiting') notify(id, { type: 'waiting' });
  else if (state === 'done') notify(id, { type: 'done', ...words });
  return true;
}

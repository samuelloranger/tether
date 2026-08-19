import { useRef } from 'react';

type Fn = (...args: never[]) => unknown;
type Dict = Record<string, unknown>;

// Domain values are rebuilt on every root render, so without this every context
// changes identity whenever anything anywhere changes — opening a menu
// invalidated all nine domains, and measurably it was the FUNCTIONS churning,
// not the data.
//
// Each function field gets one permanent forwarder that reads the current
// implementation from a ref at call time. That is deliberately the same
// read-at-call-time shape used elsewhere in this codebase for correctness: a
// forwarder can never capture a stale closure the way a useCallback with a
// hand-written dependency array can. The remaining data fields are compared
// shallowly, so a domain keeps its previous identity until one of its own
// values actually changes.
export function useStableDomain<T extends Dict>(value: T): T {
  const latest = useRef<T>(value);
  latest.current = value;
  const forwarders = useRef(new Map<string, Fn>());
  const previous = useRef<T | null>(null);

  const next: Dict = {};
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (typeof field !== 'function') {
      next[key] = field;
      continue;
    }
    let forwarder = forwarders.current.get(key);
    if (!forwarder) {
      forwarder = ((...args: never[]) => (latest.current[key] as Fn)(...args)) as Fn;
      forwarders.current.set(key, forwarder);
    }
    next[key] = forwarder;
  }

  const prev = previous.current;
  const keys = Object.keys(next);
  const unchanged =
    prev !== null &&
    keys.length === Object.keys(prev).length &&
    keys.every((key) => next[key] === (prev as Dict)[key]);
  if (unchanged) return prev;
  previous.current = next as T;
  return next as T;
}

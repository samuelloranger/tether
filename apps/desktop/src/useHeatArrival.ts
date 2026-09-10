import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ARRIVAL_MS, type LitState, shouldAnnounceArrival } from './litTheme';

/**
 * Drives `data-arriving`: the state just ENTERED while the swell runs, else null. `settled`
 * withholds it until one live state has shown, so a session already waiting at boot stays quiet.
 */
export function useHeatArrival(state: LitState): LitState | null {
  const previous = useRef<LitState>(state);
  const settled = useRef(state !== 'none');
  const [arriving, setArriving] = useState<LitState | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    const wasSettled = settled.current;
    if (state !== 'none') settled.current = true;

    if (!shouldAnnounceArrival(before, state, wasSettled)) {
      // Leaving waiting mid-swell must clear the flag itself: the cleanup cancels the
      // timer that would have, and a stuck attribute replays the animation on re-render.
      if (state !== 'waiting') setArriving(null);
      return;
    }

    setArriving(state);
    const timer = window.setTimeout(() => setArriving(null), ARRIVAL_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  return arriving;
}

/**
 * The flavour's custom properties plus the two attributes index.css times heat from.
 * `data-lit` is the state being ENTERED (asymmetric timing); `data-arriving` marks the swell.
 */
export function useShellChrome(state: LitState, style: CSSProperties) {
  const arriving = useHeatArrival(state);
  return {
    style,
    'data-lit': state,
    ...(arriving ? { 'data-arriving': arriving } : {}),
  };
}

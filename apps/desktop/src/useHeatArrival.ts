import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ARRIVAL_MS, type LitState, shouldAnnounceArrival } from './litTheme';

/**
 * Drives `data-arriving` on the app shell: the state the chrome has just
 * ENTERED, for as long as the swell runs, and null otherwise.
 *
 * The ref starts at the state the app mounts with, so opening the app onto a
 * session that is already waiting does not fire the animation — a swell on
 * launch would be page-load choreography, which this app does not do. It only
 * fires on a change the user is present for.
 */
export function useHeatArrival(state: LitState): LitState | null {
  const previous = useRef<LitState>(state);
  const [arriving, setArriving] = useState<LitState | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = state;

    if (!shouldAnnounceArrival(before, state)) {
      // Leaving waiting mid-swell has to clear the flag itself: the cleanup
      // below cancels the timer that would otherwise have done it, and a stuck
      // attribute would replay the animation on the next unrelated re-render.
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
 * Everything the app shell wears: the flavour's custom properties, plus the two
 * attributes index.css reads to time the heat.
 *
 * `data-lit` is the state being ENTERED, which is what makes the transition
 * asymmetric — 260ms into working, 340ms into waiting, 700ms back down to
 * quiet. `data-arriving` is present only while the swell runs.
 */
export function useShellChrome(state: LitState, style: CSSProperties) {
  const arriving = useHeatArrival(state);
  return {
    style,
    'data-lit': state,
    ...(arriving ? { 'data-arriving': arriving } : {}),
  };
}

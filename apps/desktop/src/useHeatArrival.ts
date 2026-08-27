import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ARRIVAL_MS, type LitState, shouldAnnounceArrival } from './litTheme';

/**
 * Drives `data-arriving` on the app shell: the state the chrome has just
 * ENTERED, for as long as the swell runs, and null otherwise.
 *
 * Two things keep launch quiet. The ref starts at the state the app mounts
 * with, and `settled` withholds the swell until the chrome has shown one live
 * state — the app boots with an empty session list, so every session arrives as
 * `none → something` once polling answers, and a session that was already
 * waiting when you opened the app would otherwise announce itself as though it
 * had just stopped to ask you a question.
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

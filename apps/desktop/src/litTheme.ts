import { activityDotKey, type DotKey } from './activity';
import { isRecentlyActive } from './desktopNavigation';
import type { UiTheme } from './preferences';
import type { DrawerSession } from './types';

/**
 * `none` is not "idle": a stopped session, or no session at all, must not tint
 * the app warm or cool — a dead shell that keeps glowing reads as a live one.
 */
export type LitState = 'working' | 'waiting' | 'done' | 'idle' | 'none';

/** Classified exactly as the drawer classifies its own rows, so the row and
 * the chrome can never disagree about what a session is doing. */
export function activeSessionDot(
  sessions: DrawerSession[],
  hostId: string | null,
  sessionId: string,
): { session: DrawerSession | null; dot: DotKey | null } {
  const session = sessions.find((row) => row.hostId === hostId && row.id === sessionId) ?? null;
  if (!session) return { session: null, dot: null };
  return {
    session,
    dot: activityDotKey(session.status, session.activity, isRecentlyActive(session.last_output_at)),
  };
}

/** Reuses the drawer's own classification so the row and the chrome can never disagree. */
export function litStateFor(dot: DotKey | null): LitState {
  switch (dot) {
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'done':
      return 'done';
    case 'idle':
      return 'idle';
    default:
      // 'stopped' and null both mean "nothing is running here".
      return 'none';
  }
}

/** Per-state rather than one shared alpha: ember reads much hotter than amber
 * at parity, which made waiting look like an alarm rather than a state. */
const BLOOM: Record<LitState, { b1: string; b2: string; b3: string; rim: string }> = {
  working: { b1: '13%', b2: '6%', b3: '2%', rim: '55%' },
  waiting: { b1: '9%', b2: '4%', b3: '1.5%', rim: '46%' },
  // Between waiting and idle: warmer than a shell that is merely alive, quieter
  // than one that is blocked. Finishing is worth noticing and nothing more.
  done: { b1: '8%', b2: '3.5%', b3: '1.2%', rim: '36%' },
  idle: { b1: '7%', b2: '3%', b3: '1%', rim: '30%' },
  none: { b1: '0%', b2: '0%', b3: '0%', rim: '0%' },
};

export function litColor(theme: UiTheme, state: LitState): string {
  switch (state) {
    case 'working':
      return theme.heat.working;
    case 'waiting':
      return theme.heat.waiting;
    case 'done':
      return theme.heat.done;
    case 'idle':
      return theme.heat.cool;
    case 'none':
      return theme.colors.textFaint;
  }
}

/** Matches the `heat-arrive` keyframe in `index.css` plus slack so the
 * attribute outlives the animation rather than cutting it off. */
export const ARRIVAL_MS = 800;

/** Fires only on ENTERING waiting, since the drawer re-reports state every poll
 * and `settled` keeps the swell from firing on startup's initial `none → waiting`. */
export function shouldAnnounceArrival(prev: LitState, next: LitState, settled: boolean): boolean {
  return settled && next === 'waiting' && prev !== 'waiting';
}

/** Everything tinted in `index.css` resolves through these, so re-tinting the
 * app on a session switch is four variable writes. */
export function litVars(theme: UiTheme, state: LitState): Record<string, string> {
  const bloom = BLOOM[state];
  return {
    '--lit': litColor(theme, state),
    '--b1': bloom.b1,
    '--b2': bloom.b2,
    '--b3': bloom.b3,
    '--rim': bloom.rim,
  };
}

/** Every token the flavour defines is published — the previous version emitted
 * nine of sixteen, so many `index.css` rules carried a hard-coded fallback. */
export function shellVars(theme: UiTheme, state: LitState): Record<string, string> {
  const c = theme.colors;
  return {
    '--background': c.background,
    '--surface': c.surface,
    '--surface-raised': c.surfaceRaised,
    '--input': c.input,
    '--text': c.text,
    '--text-muted': c.textMuted,
    '--text-faint': c.textFaint,
    '--border': c.border,
    '--overlay': c.overlay,
    '--selected': c.selected,
    '--accent': c.accent,
    '--accent-text': c.accentText,
    '--success': c.success,
    '--warning': c.warning,
    '--danger': c.danger,
    '--info': c.info,
    // So padding around the emulator matches it; `--input` was close enough to
    // be invisible in dark but showed up as a pale gutter in light flavours.
    '--term-bg': theme.terminal.background,
    ...litVars(theme, state),
  };
}

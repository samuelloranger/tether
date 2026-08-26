import { activityDotKey, type DotKey } from './activity';
import { isRecentlyActive } from './desktopNavigation';
import type { UiTheme } from './preferences';
import type { DrawerSession } from './types';

/**
 * What the chrome is currently wearing.
 *
 * `none` is not "idle": a stopped session, or no session at all, must not tint
 * the app warm or cool — a dead shell that keeps glowing reads as a live one.
 */
export type LitState = 'working' | 'waiting' | 'idle' | 'none';

/**
 * The session the chrome is currently wearing, classified exactly as the drawer
 * classifies its own rows — so the row and the chrome can never disagree about
 * what a session is doing.
 */
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
    case 'idle':
      return 'idle';
    default:
      // 'stopped' and null both mean "nothing is running here".
      return 'none';
  }
}

/**
 * Bloom alphas are per-state rather than one shared value on purpose.
 *
 * Ember reads considerably hotter than amber at the same alpha — at parity the
 * waiting state stopped looking like a state and started looking like an alarm.
 * Idle is quieter than both: it should register as "alive" and nothing more.
 */
const BLOOM: Record<LitState, { b1: string; b2: string; b3: string; rim: string }> = {
  working: { b1: '13%', b2: '6%', b3: '2%', rim: '55%' },
  waiting: { b1: '9%', b2: '4%', b3: '1.5%', rim: '46%' },
  idle: { b1: '7%', b2: '3%', b3: '1%', rim: '30%' },
  none: { b1: '0%', b2: '0%', b3: '0%', rim: '0%' },
};

export function litColor(theme: UiTheme, state: LitState): string {
  switch (state) {
    case 'working':
      return theme.heat.working;
    case 'waiting':
      return theme.heat.waiting;
    case 'idle':
      return theme.heat.cool;
    case 'none':
      return theme.colors.textFaint;
  }
}

/**
 * The CSS custom properties the whole visual language reads from. Everything
 * tinted in `index.css` — the mark, the selected card, its edge light, the
 * toolbar chip, the screen rim, the atmospheric bloom — resolves through these,
 * so re-tinting the app on a session switch is four variable writes.
 */
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

/**
 * The complete custom-property set for the app shell.
 *
 * Every token the flavour defines is published — the previous version emitted
 * nine of sixteen, which is why so many rules in `index.css` used to carry a
 * hard-coded Catppuccin fallback that silently won under other flavours.
 */
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
    // The terminal's own background, so the padding around the emulator can
    // match it. `--input` is close enough to be invisible in a dark flavour and
    // obviously wrong in a light one, which showed up as a pale gutter down the
    // left edge of the terminal.
    '--term-bg': theme.terminal.background,
    ...litVars(theme, state),
  };
}

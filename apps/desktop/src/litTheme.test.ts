import { describe, expect, it } from 'bun:test';
import { ARRIVAL_MS, litColor, litStateFor, litVars, shouldAnnounceArrival } from './litTheme';
import { UI_THEMES } from './preferences';

const dark = UI_THEMES['default-dark'];

describe('litStateFor', () => {
  it('carries the drawer classification straight through', () => {
    expect(litStateFor('working')).toBe('working');
    expect(litStateFor('waiting')).toBe('waiting');
    expect(litStateFor('idle')).toBe('idle');
  });

  // A dead shell that keeps glowing reads as a live one, which is the whole
  // failure this guards against.
  it('does not tint a stopped session', () => {
    expect(litStateFor('stopped')).toBe('none');
  });

  it('does not tint when there is no session at all', () => {
    expect(litStateFor(null)).toBe('none');
  });
});

describe('litColor', () => {
  it('maps each state onto the flavour own heat triple', () => {
    expect(litColor(dark, 'working')).toBe(dark.heat.working);
    expect(litColor(dark, 'waiting')).toBe(dark.heat.waiting);
    expect(litColor(dark, 'idle')).toBe(dark.heat.cool);
  });

  it('falls back to a neutral for none, never to a heat colour', () => {
    const none = litColor(dark, 'none');
    expect(none).toBe(dark.colors.textFaint);
    expect([dark.heat.working, dark.heat.waiting, dark.heat.cool]).not.toContain(none);
  });

  it('stays inside the palette of every flavour', () => {
    for (const theme of Object.values(UI_THEMES)) {
      expect(litColor(theme, 'working')).toBe(theme.heat.working);
      expect(litColor(theme, 'waiting')).toBe(theme.heat.waiting);
      expect(litColor(theme, 'idle')).toBe(theme.heat.cool);
    }
  });
});

describe('litVars', () => {
  it('emits every variable index.css reads', () => {
    const vars = litVars(dark, 'working');
    expect(Object.keys(vars).sort()).toEqual(['--b1', '--b2', '--b3', '--lit', '--rim']);
  });

  it('zeroes the bloom entirely when nothing is running', () => {
    const vars = litVars(dark, 'none');
    expect(vars['--b1']).toBe('0%');
    expect(vars['--b2']).toBe('0%');
    expect(vars['--b3']).toBe('0%');
    expect(vars['--rim']).toBe('0%');
  });

  // Ember reads hotter than amber at equal alpha; at parity waiting stopped
  // looking like a state and started looking like an alarm.
  it('scales waiting back below working so it is not an alarm', () => {
    const pct = (v: string) => Number.parseFloat(v);
    const working = litVars(dark, 'working');
    const waiting = litVars(dark, 'waiting');
    expect(pct(waiting['--b1'])).toBeLessThan(pct(working['--b1']));
    expect(pct(waiting['--rim'])).toBeLessThan(pct(working['--rim']));
  });

  it('keeps idle the quietest of the three live states', () => {
    const pct = (v: string) => Number.parseFloat(v);
    const idle = pct(litVars(dark, 'idle')['--b1']);
    expect(idle).toBeLessThan(pct(litVars(dark, 'waiting')['--b1']));
    expect(idle).toBeGreaterThan(0);
  });
});

describe('shouldAnnounceArrival', () => {
  it('fires when a shell stops to ask for input', () => {
    expect(shouldAnnounceArrival('working', 'waiting', true)).toBe(true);
    expect(shouldAnnounceArrival('idle', 'waiting', true)).toBe(true);
    expect(shouldAnnounceArrival('none', 'waiting', true)).toBe(true);
  });

  // The drawer re-reports state on every poll; a swell per poll is a strobe.
  it('does not re-announce a session that is already waiting', () => {
    expect(shouldAnnounceArrival('waiting', 'waiting', true)).toBe(false);
  });

  // The app boots with no sessions, so the first poll turns `none` into
  // whatever the session already was. Nothing happened; loading finished.
  it('stays quiet while the app is still hydrating', () => {
    expect(shouldAnnounceArrival('none', 'waiting', false)).toBe(false);
  });

  it('stays quiet for every other transition', () => {
    expect(shouldAnnounceArrival('waiting', 'working', true)).toBe(false);
    expect(shouldAnnounceArrival('idle', 'working', true)).toBe(false);
    expect(shouldAnnounceArrival('working', 'none', true)).toBe(false);
  });

  it('outlives the keyframe it accompanies', () => {
    expect(ARRIVAL_MS).toBeGreaterThan(720);
  });
});

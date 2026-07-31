export const HIT_SLOP = { top: 8, right: 8, bottom: 8, left: 8 } as const;
/** iOS HIG floor. Android Material wants 48 — see `minTouchTarget()`. */
export const MIN_TOUCH_TARGET = 44;
export const MIN_TOUCH_TARGET_ANDROID = 48;
// Bezel chrome: tight radii. Catppuccin themes still share these tokens — color
// carries their identity; geometry stays instrument-sharp across the app.
export const SURFACE_RADIUS = { control: 2, panel: 4, hero: 0 } as const;

/**
 * Platform-aware minimum touch target. Avoids a static `react-native` import so
 * bun:test modules that only need the iOS floor stay loadable.
 */
export function minTouchTarget(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require('react-native') as typeof import('react-native');
    return Platform.OS === 'android' ? MIN_TOUCH_TARGET_ANDROID : MIN_TOUCH_TARGET;
  } catch {
    return MIN_TOUCH_TARGET;
  }
}

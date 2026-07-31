export const HIT_SLOP = { top: 8, right: 8, bottom: 8, left: 8 } as const;
export const MIN_TOUCH_TARGET = 44;
// Bezel chrome: tight radii. Catppuccin themes still share these tokens — color
// carries their identity; geometry stays instrument-sharp across the app.
export const SURFACE_RADIUS = { control: 2, panel: 4, hero: 0 } as const;

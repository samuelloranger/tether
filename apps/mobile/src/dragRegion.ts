// Window-drag support for the custom title bar (desktop/web only).
//
// Tauri turns an element with `data-tauri-drag-region` into a window drag handle
// (and double-click → maximize). The attribute VALUE matters (see Tauri
// window/scripts/drag.js): a bare/empty value means "only direct clicks on THIS
// element drag" — which never fires here because the bar is covered by child
// Views. We use "deep" so a click anywhere in the bar's subtree drags the
// window; Tauri automatically excludes clickable elements (our controls are
// role="button"), so they still receive their presses.
//
// react-native-web renders `dataSet={{ tauriDragRegion: 'deep' }}` as
// `data-tauri-drag-region="deep"`. The `app-region` CSS below only matters on
// Windows (Chromium/WebView2); it is a no-op on Linux/macOS, where dragging
// relies solely on Tauri's JS handler. `data-tauri-no-drag` is ignored by Tauri
// itself and exists only for that Windows CSS `no-drag` path.

export const DRAG_REGION_CSS = `
[data-tauri-drag-region] { app-region: drag; -webkit-app-region: drag; }
[data-tauri-no-drag] { app-region: no-drag; -webkit-app-region: no-drag; }
`;

const STYLE_ID = 'tether-drag-region-styles';

export function injectDragRegionStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = DRAG_REGION_CSS;
  document.head.appendChild(el);
}

// RN-web's View type (from `react-native`) doesn't declare `dataSet`, so these
// are typed `any` and spread onto the target View.
export const DRAG_PROPS: any = { dataSet: { tauriDragRegion: 'deep' } };
export const NO_DRAG_PROPS: any = { dataSet: { tauriNoDrag: '' } };

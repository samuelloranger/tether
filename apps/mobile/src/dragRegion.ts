// Window-drag support for the custom title bar (desktop/web only).
//
// Tauri turns any element with `data-tauri-drag-region` into a window drag
// handle (and double-click → maximize). On Windows the drag is region-based, so
// interactive children must opt OUT with `data-tauri-no-drag`, else they become
// dead zones. react-native-web renders `dataSet={{ tauriDragRegion: '' }}` as
// the `data-tauri-drag-region` attribute; the `app-region` CSS below is what
// Windows needs for touch/pen dragging (`-webkit-` for WebKitGTK/WKWebView).

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
export const DRAG_PROPS: any = { dataSet: { tauriDragRegion: '' } };
export const NO_DRAG_PROPS: any = { dataSet: { tauriNoDrag: '' } };

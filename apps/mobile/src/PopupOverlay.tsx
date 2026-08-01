import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import { StyleSheet, View } from 'react-native';

// A same-window portal: content mounted here draws above everything without
// opening a new native window. RN's <Modal> does that on iOS by becoming a
// second UIWindow, which steals first-responder status from whatever
// TextInput currently holds the keyboard — HoldPopupKey's Modal-based popup
// was dismissing the keyboard on every long-press for exactly that reason.
const PopupOverlayContext = createContext<{
  setContent: (id: string, node: ReactNode | null) => void;
} | null>(null);

export function PopupOverlayProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Record<string, ReactNode>>({});
  const setContent = useCallback((id: string, node: ReactNode | null) => {
    setItems((prev) => {
      if (node == null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: node };
    });
  }, []);
  return (
    <PopupOverlayContext.Provider value={{ setContent }}>
      {children}
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {Object.entries(items).map(([id, node]) => (
          <View key={id} pointerEvents="none" style={StyleSheet.absoluteFill}>
            {node}
          </View>
        ))}
      </View>
    </PopupOverlayContext.Provider>
  );
}

export function usePopupOverlay() {
  const ctx = useContext(PopupOverlayContext);
  if (!ctx) throw new Error('usePopupOverlay must be used within a PopupOverlayProvider');
  return ctx;
}

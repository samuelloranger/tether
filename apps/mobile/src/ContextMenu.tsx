import { Modal, Pressable, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

// Desktop right-click menu. Rendered in a Modal so it portals to the viewport
// root — client coordinates then map 1:1 (no sidebar offset). Renders nothing
// when there's no anchor.
export function ContextMenu({
  menu,
  onClose,
  onCopy,
  onPaste,
  onSelectAll,
}: {
  menu: { x: number; y: number } | null;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}) {
  if (!menu) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.ctxBackdrop} onPress={onClose}>
        <View style={[styles.ctxMenu, { left: menu.x, top: menu.y }]}>
          <TouchableOpacity
            style={styles.ctxRow}
            onPress={() => {
              onCopy();
              onClose();
            }}
          >
            <Feather name="copy" size={15} color="#cbd5e1" />
            <Text style={styles.ctxText}>Copy</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.ctxRow}
            onPress={() => {
              onPaste();
              onClose();
            }}
          >
            <Feather name="clipboard" size={15} color="#cbd5e1" />
            <Text style={styles.ctxText}>Paste</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.ctxRow}
            onPress={() => {
              onSelectAll();
              onClose();
            }}
          >
            <Feather name="maximize" size={15} color="#cbd5e1" />
            <Text style={styles.ctxText}>Select all</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  ctxBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200 },
  ctxMenu: {
    position: 'absolute',
    minWidth: 168,
    backgroundColor: '#0b0f19',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 8,
    paddingVertical: 4,
  },
  ctxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  ctxText: { color: '#cbd5e1', fontSize: 13 },
});

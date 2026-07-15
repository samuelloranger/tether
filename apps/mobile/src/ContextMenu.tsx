import { Modal, Pressable, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';

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
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
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
            <Feather name="copy" size={15} color={theme.colors.text} />
            <Text style={styles.ctxText}>Copy</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.ctxRow}
            onPress={() => {
              onPaste();
              onClose();
            }}
          >
            <Feather name="clipboard" size={15} color={theme.colors.text} />
            <Text style={styles.ctxText}>Paste</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.ctxRow}
            onPress={() => {
              onSelectAll();
              onClose();
            }}
          >
            <Feather name="maximize" size={15} color={theme.colors.text} />
            <Text style={styles.ctxText}>Select all</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
  ctxBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200 },
  ctxMenu: {
    position: 'absolute',
    minWidth: 168,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
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
  ctxText: { color: c.text, fontSize: 13 },
  });
}

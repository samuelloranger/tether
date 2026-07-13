import { Modal, Pressable, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { isDesktop } from './platform';

// Header ⋯ overflow menu. Actions are passed in; the parent closes the menu.
export function OverflowMenu({
  visible,
  onClose,
  onRename,
  fontSize,
  onFontDelta,
  onSearch,
  onSnippets,
  onCheckUpdates,
  onRestart,
}: {
  visible: boolean;
  onClose: () => void;
  onRename: () => void;
  fontSize: number;
  onFontDelta: (delta: number) => void;
  onSearch: () => void;
  onSnippets: () => void;
  onCheckUpdates: () => void;
  onRestart: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.overflowMenuBackdrop} onPress={onClose}>
        <Pressable style={[styles.menuPanel, { marginTop: insets.top + 52 }]} onPress={() => {}}>
          <TouchableOpacity style={styles.menuRow} onPress={onRename}>
            <Feather name="edit-2" size={16} color="#cbd5e1" />
            <Text style={styles.menuRowText}>Rename terminal</Text>
          </TouchableOpacity>
          <View style={styles.menuRow}>
            <Feather name="type" size={16} color="#cbd5e1" />
            <Text style={[styles.menuRowText, { flex: 1 }]} numberOfLines={1}>
              Font size
            </Text>
            <TouchableOpacity
              style={styles.fontStepBtn}
              onPress={() => onFontDelta(-1)}
              accessibilityLabel="Decrease font size"
            >
              <Text style={styles.fontStepText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.fontSizeValue}>{fontSize}</Text>
            <TouchableOpacity
              style={styles.fontStepBtn}
              onPress={() => onFontDelta(1)}
              accessibilityLabel="Increase font size"
            >
              <Text style={styles.fontStepText}>+</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.menuRow} onPress={onSearch}>
            <Feather name="search" size={16} color="#cbd5e1" />
            <Text style={styles.menuRowText}>Search displayed transcript</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuRow} onPress={onSnippets}>
            <Feather name="terminal" size={16} color="#cbd5e1" />
            <Text style={styles.menuRowText}>Saved commands</Text>
          </TouchableOpacity>
          {isDesktop && (
            <TouchableOpacity style={styles.menuRow} onPress={onCheckUpdates}>
              <Feather name="download" size={16} color="#cbd5e1" />
              <Text style={styles.menuRowText}>Check for updates</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.menuRow} onPress={onRestart}>
            <Feather name="refresh-cw" size={16} color="#f87171" />
            <Text style={[styles.menuRowText, { color: '#f87171' }]}>Restart terminal</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overflowMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
  },
  menuPanel: {
    alignSelf: 'flex-end',
    marginRight: 12,
    minWidth: 240,
    backgroundColor: '#0b0f19',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    paddingVertical: 6,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  menuRowText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#cbd5e1',
  },
  fontStepBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fontStepText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  fontSizeValue: {
    minWidth: 24,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: '#e2e8f0',
  },
});

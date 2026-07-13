import type { RefObject } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { MONO } from './styles';

// Fullscreen selectable-text view (long-press the terminal to open): filter +
// copy the displayed transcript. The text is read-only and natively selectable.
export function SelectionView({
  visible,
  onClose,
  onCopy,
  searchQuery,
  onSearchChange,
  searchInputRef,
  text,
}: {
  visible: boolean;
  onClose: () => void;
  onCopy: () => void;
  searchQuery: string;
  onSearchChange: (t: string) => void;
  searchInputRef: RefObject<TextInput | null>;
  text: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={[styles.selectionViewContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      >
        <View style={styles.selectionViewHeader}>
          <Text style={styles.selectionViewTitle}>Select text (displayed transcript)</Text>
          <View style={styles.selectionViewHeaderBtns}>
            <TouchableOpacity
              style={styles.selectionViewHeaderBtn}
              onPress={onCopy}
              accessibilityRole="button"
              accessibilityLabel="Copy displayed transcript"
            >
              <Text style={styles.selectionViewHeaderBtnText}>Copy displayed transcript</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.selectionViewHeaderBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Feather name="x" size={20} color="#cbd5e1" />
            </TouchableOpacity>
          </View>
        </View>
        <TextInput
          ref={searchInputRef}
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={onSearchChange}
          placeholder="Filter lines…"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance="dark"
        />
        {visible && (
          <TextInput style={styles.selectionViewText} value={text} editable={false} multiline scrollEnabled />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  selectionViewContainer: {
    flex: 1,
    backgroundColor: '#070a13',
  },
  selectionViewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  selectionViewTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  selectionViewHeaderBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  selectionViewHeaderBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  selectionViewHeaderBtnText: {
    color: '#22d3ee',
    fontWeight: '600',
    fontSize: 14,
  },
  searchInput: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#e2e8f0',
    fontSize: 14,
  },
  selectionViewText: {
    flex: 1,
    padding: 16,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 18,
    color: '#cbd5e1',
  },
});

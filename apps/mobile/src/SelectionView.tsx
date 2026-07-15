import { useEffect, useRef, type RefObject } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { MONO } from './styles';

// Fullscreen selectable-text view (long-press the terminal to open): filter the
// displayed transcript and select/copy it via the OS's native text selection.
export function SelectionView({
  visible,
  onClose,
  searchQuery,
  onSearchChange,
  searchInputRef,
  text,
  insets,
}: {
  visible: boolean;
  onClose: () => void;
  searchQuery: string;
  onSearchChange: (t: string) => void;
  searchInputRef: RefObject<TextInput | null>;
  text: string;
  // Computed outside the Modal and passed in: useSafeAreaInsets() called from
  // inside a <Modal> resolves against the wrong native view hierarchy on iOS
  // (a documented react-native-safe-area-context limitation), pinning the
  // header under the status bar/notch.
  insets: { top: number; bottom: number };
}) {
  const scrollRef = useRef<ScrollView>(null);
  const transcriptRef = useRef<TextInput>(null);
  useEffect(() => {
    if (visible) scrollRef.current?.scrollToEnd({ animated: false });
  }, [visible]);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={[styles.selectionViewContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      >
        <View style={styles.selectionViewHeader}>
          <Text style={styles.selectionViewTitle} numberOfLines={1} ellipsizeMode="tail">
            Select text (displayed transcript)
          </Text>
          <TouchableOpacity
            style={styles.selectionViewHeaderBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Feather name="x" size={20} color="#cbd5e1" />
          </TouchableOpacity>
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
          <ScrollView ref={scrollRef} style={styles.selectionViewScroll} contentContainerStyle={styles.selectionViewScrollContent}>
            <TextInput
              ref={transcriptRef}
              style={styles.selectionViewText}
              value={text}
              // editable (not editable={false}) is what makes iOS/Android's real
              // word/phrase drag-handle selection work at all — a non-editable
              // TextInput only supports a whole-block "Copy" long-press, same as
              // Text's selectable prop. Suppress the keyboard and snap back any
              // stray edit so it still behaves as read-only.
              editable
              showSoftInputOnFocus={false}
              caretHidden
              onChangeText={() => transcriptRef.current?.setNativeProps({ text })}
              multiline
              scrollEnabled={false}
            />
          </ScrollView>
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
    flexShrink: 1,
    marginRight: 12,
    fontSize: 16,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  selectionViewHeaderBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
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
  selectionViewScroll: {
    flex: 1,
  },
  selectionViewScrollContent: {
    padding: 16,
  },
  selectionViewText: {
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 18,
    color: '#cbd5e1',
  },
});

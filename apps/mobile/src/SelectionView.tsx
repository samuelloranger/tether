import { useEffect, useRef, useState, type RefObject } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

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
  fontFamily,
  fontSize,
  lineHeight,
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
  // The terminal's own configured font — matches what's on screen and keeps
  // the height measurement below accurate for the font actually rendered.
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const transcriptRef = useRef<TextInput>(null);
  // Real rendered height of the transcript at its actual on-device width/font,
  // learned from an invisible measurement pass below — not guessed math — so
  // the ScrollView can open with the exact scroll offset already applied
  // (no post-mount jump, no flash of line 1).
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!visible) setMeasuredHeight(null);
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
        {visible && measuredHeight === null && (
          // Invisible measurement pass: lays the real transcript text out at
          // the real on-device width/font (identical style to the visible
          // copy below) purely to learn its rendered height via onLayout —
          // no line-count/font-size arithmetic, so it's correct regardless of
          // font size, device width, or line wrapping.
          <Text
            style={[styles.selectionViewText, { fontFamily, fontSize, lineHeight }, styles.selectionViewMeasure]}
            onLayout={(e) => setMeasuredHeight(e.nativeEvent.layout.height)}
          >
            {text}
          </Text>
        )}
        {visible && measuredHeight !== null && (
          <ScrollView
            ref={scrollRef}
            style={styles.selectionViewScroll}
            contentContainerStyle={styles.selectionViewScrollContent}
            // Opens already scrolled to the last line — no post-mount jump,
            // no flash of line 1.
            contentOffset={{ x: 0, y: measuredHeight }}
          >
            <TextInput
              ref={transcriptRef}
              style={[styles.selectionViewText, { fontFamily, fontSize, lineHeight }]}
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
    color: '#cbd5e1',
  },
  // Same horizontal padding as selectionViewScrollContent, so the invisible
  // measurement pass wraps lines identically to the real scroll content.
  selectionViewMeasure: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    opacity: 0,
  },
});

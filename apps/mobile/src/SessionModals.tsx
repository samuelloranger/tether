import { Modal, Pressable, View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { MONO } from './styles';
import { THEME_OPTIONS } from './appTheme';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';

const THEME_LABELS = {
  system: 'System',
  latte: 'Latte',
  frappe: 'Frappé',
  macchiato: 'Macchiato',
  mocha: 'Mocha',
} as const;
import { isDesktop } from './platform';

const FONTS = ['FiraCode_400Regular', 'JetBrainsMono_400Regular'] as const;

// Rename the active terminal.
export function RenameModal({
  visible,
  onClose,
  value,
  onChangeText,
  placeholder,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  onSubmit: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.menuBackdrop} onPress={onClose}>
        <Pressable style={styles.renamePanel} onPress={() => {}}>
          <Text style={styles.renameTitle}>Rename terminal</Text>
          <TextInput
            style={styles.renameInput}
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={theme.colors.textFaint}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={onSubmit}
            keyboardAppearance={theme.keyboardAppearance}
          />
          <View style={styles.renameBtns}>
            <TouchableOpacity style={styles.renameBtn} onPress={onClose}>
              <Text style={styles.renameBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.renameBtn} onPress={onSubmit}>
              <Text style={[styles.renameBtnText, { color: theme.colors.info }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Saved commands (snippets) — send, delete, add.
export function SnippetsModal({
  visible,
  onClose,
  snippets,
  onSend,
  onRemove,
  draft,
  onDraftChange,
  onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  snippets: string[];
  onSend: (s: string) => void;
  onRemove: (index: number) => void;
  draft: string;
  onDraftChange: (t: string) => void;
  onAdd: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.menuBackdrop} onPress={onClose}>
        <Pressable style={styles.renamePanel} onPress={() => {}}>
          <Text style={styles.renameTitle}>Saved commands</Text>
          {snippets.length === 0 && (
            <Text style={styles.snippetEmpty}>No saved commands yet. Add one below.</Text>
          )}
          {snippets.map((s, i) => (
            <View key={`${s}-${i}`} style={styles.snippetRow}>
              <TouchableOpacity style={styles.snippetSend} onPress={() => onSend(s)}>
                <Text style={styles.snippetText} numberOfLines={1}>
                  {s}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.snippetDelete}
                onPress={() => onRemove(i)}
                accessibilityLabel={`Delete snippet ${s}`}
              >
                <Feather name="x" size={16} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
          <View style={styles.snippetAddRow}>
            <TextInput
              style={[styles.renameInput, { flex: 1 }]}
              value={draft}
              onChangeText={onDraftChange}
              placeholder="New snippet (e.g. git status)"
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={onAdd}
              keyboardAppearance={theme.keyboardAppearance}
            />
            <TouchableOpacity style={styles.snippetAddBtn} onPress={onAdd}>
              <Feather name="plus" size={18} color={theme.colors.info} />
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Theme picker (+ desktop font picker — added in Task 12).
export function AppearanceModal({
  visible,
  onClose,
  fontFamily,
  onFontChange,
}: {
  visible: boolean;
  onClose: () => void;
  fontFamily: string;
  onFontChange: (fontFamily: string) => void;
}) {
  const { preference, setPreference, theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.menuBackdrop} onPress={onClose}>
        <Pressable style={styles.renamePanel} onPress={() => {}}>
          <Text style={styles.renameTitle}>Appearance</Text>
          {THEME_OPTIONS.map((id) => (
            <TouchableOpacity
              key={id}
              style={[
                styles.renameBtn,
                { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
              ]}
              onPress={() => setPreference(id)}
            >
              <Text style={styles.renameBtnText}>{THEME_LABELS[id]}</Text>
              {id === preference && <Feather name="check" size={16} color={theme.colors.info} />}
            </TouchableOpacity>
          ))}
          {isDesktop && (
            <>
              <Text style={[styles.renameTitle, { marginTop: 12 }]}>Font</Text>
              {FONTS.map((font) => (
                <TouchableOpacity
                  key={font}
                  style={[
                    styles.renameBtn,
                    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
                  ]}
                  onPress={() => onFontChange(font)}
                >
                  <Text style={[styles.renameBtnText, { fontFamily: font }]}>{font.split('_')[0]}</Text>
                  {font === fontFamily && <Feather name="check" size={16} color={theme.colors.info} />}
                </TouchableOpacity>
              ))}
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
  menuBackdrop: {
    flex: 1,
    backgroundColor: c.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  renamePanel: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 20,
    gap: 14,
  },
  renameTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
  },
  renameInput: {
    backgroundColor: c.input,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: c.text,
    fontSize: 15,
  },
  renameBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
  },
  renameBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  renameBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: c.textMuted,
  },
  snippetEmpty: {
    color: c.textFaint,
    fontSize: 13,
  },
  snippetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  snippetSend: {
    flex: 1,
    backgroundColor: c.input,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  snippetText: {
    color: c.text,
    fontSize: 14,
    fontFamily: MONO,
  },
  snippetDelete: {
    padding: 8,
  },
  snippetAddRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  snippetAddBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: c.input,
    justifyContent: 'center',
    alignItems: 'center',
  },
  });
}

import Feather from '@expo/vector-icons/Feather';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';

// Desktop self-update modal (styled + progress). Renders nothing when no update
// is pending.
export function UpdateModal({
  info,
  updating,
  pct,
  label,
  onDismiss,
  onUpdate,
  onDownload,
}: {
  info: { version: string; current: string; canSelfInstall: boolean } | null;
  updating: boolean;
  pct: number;
  label: string;
  onDismiss: () => void;
  onUpdate: () => void;
  onDownload: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  if (!info) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.updateBackdrop}>
        <View style={styles.updateCard}>
          <View style={styles.updateHeaderRow}>
            <Feather name="download" size={16} color={theme.colors.accent} />
            <Text style={styles.updateTitle}>Update available</Text>
          </View>
          <Text style={styles.updateVersion}>Tether {info.version}</Text>
          <Text style={styles.updateSub}>You have {info.current}</Text>
          {!info.canSelfInstall && (
            <Text style={styles.updateNote}>
              This install updates through your package manager — download the new package.
            </Text>
          )}

          {updating ? (
            <View style={styles.updateProgressWrap}>
              <View style={styles.updateTrack}>
                <View style={[styles.updateFill, { width: `${pct}%` }]} />
              </View>
              <Text style={styles.updateProgressText}>{label}</Text>
            </View>
          ) : (
            <View style={styles.updateBtns}>
              <TouchableOpacity style={styles.updateBtn} onPress={onDismiss}>
                <Text style={styles.updateBtnText}>Later</Text>
              </TouchableOpacity>
              {info.canSelfInstall ? (
                <TouchableOpacity
                  style={[styles.updateBtn, styles.updateBtnPrimary]}
                  onPress={onUpdate}
                >
                  <Text style={[styles.updateBtnText, styles.updateBtnTextPrimary]}>Update</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.updateBtn, styles.updateBtnPrimary]}
                  onPress={onDownload}
                >
                  <Text style={[styles.updateBtnText, styles.updateBtnTextPrimary]}>Download</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    updateBackdrop: {
      flex: 1,
      backgroundColor: c.overlay,
      alignItems: 'center',
      justifyContent: 'center',
    },
    updateCard: {
      width: 360,
      maxWidth: '90%',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      padding: 20,
    },
    updateHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
    updateTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
    updateVersion: { color: c.text, fontSize: 18, fontWeight: '700' },
    updateSub: { color: c.textFaint, fontSize: 12, marginTop: 2 },
    updateNote: { color: c.textMuted, fontSize: 12, marginTop: 12, lineHeight: 17 },
    updateProgressWrap: { marginTop: 18 },
    updateTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: c.surfaceRaised,
      overflow: 'hidden',
    },
    updateFill: { height: 8, borderRadius: 4, backgroundColor: c.accent },
    updateProgressText: { color: c.textMuted, fontSize: 12, marginTop: 8, textAlign: 'center' },
    updateBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
    updateBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
    updateBtnPrimary: { backgroundColor: c.accent },
    updateBtnText: { color: c.textMuted, fontSize: 13, fontWeight: '600' },
    updateBtnTextPrimary: { color: c.accentText },
  });
}

import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

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
  if (!info) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.updateBackdrop}>
        <View style={styles.updateCard}>
          <View style={styles.updateHeaderRow}>
            <Feather name="download" size={16} color="#818cf8" />
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
                <TouchableOpacity style={[styles.updateBtn, styles.updateBtnPrimary]} onPress={onUpdate}>
                  <Text style={[styles.updateBtnText, styles.updateBtnTextPrimary]}>Update</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={[styles.updateBtn, styles.updateBtnPrimary]} onPress={onDownload}>
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

const styles = StyleSheet.create({
  updateBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  updateCard: {
    width: 360,
    maxWidth: '90%',
    backgroundColor: '#0b0f19',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    padding: 20,
  },
  updateHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  updateTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  updateVersion: { color: '#f8fafc', fontSize: 18, fontWeight: '700' },
  updateSub: { color: '#64748b', fontSize: 12, marginTop: 2 },
  updateNote: { color: '#94a3b8', fontSize: 12, marginTop: 12, lineHeight: 17 },
  updateProgressWrap: { marginTop: 18 },
  updateTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  updateFill: { height: 8, borderRadius: 4, backgroundColor: '#818cf8' },
  updateProgressText: { color: '#94a3b8', fontSize: 12, marginTop: 8, textAlign: 'center' },
  updateBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
  updateBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
  updateBtnPrimary: { backgroundColor: '#3730a3' },
  updateBtnText: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  updateBtnTextPrimary: { color: '#fff' },
});

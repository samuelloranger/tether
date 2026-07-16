import { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { subscribeAlert, type AlertRequest } from './dialog';

// Desktop in-app replacement for native OS alert/confirm dialogs (see dialog.ts
// for why). Renders nothing when no alert is pending.
export function AlertModal() {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const [req, setReq] = useState<AlertRequest | null>(null);

  useEffect(() => subscribeAlert(setReq), []);

  if (!req) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (req.kind === 'notify') req.resolve();
        else req.resolve(false);
      }}
    >
      <View style={styles.alertBackdrop}>
        <View style={styles.alertCard}>
          <Text style={styles.alertTitle}>{req.title}</Text>
          <Text style={styles.alertBody}>{req.body}</Text>

          {req.kind === 'notify' ? (
            <View style={styles.alertBtns}>
              <TouchableOpacity
                style={[styles.alertBtn, styles.alertBtnPrimary]}
                onPress={req.resolve}
              >
                <Text style={[styles.alertBtnText, styles.alertBtnTextPrimary]}>OK</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.alertBtns}>
              <TouchableOpacity style={styles.alertBtn} onPress={() => req.resolve(false)}>
                <Text style={styles.alertBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.alertBtn,
                  req.destructive ? styles.alertBtnDestructive : styles.alertBtnPrimary,
                ]}
                onPress={() => req.resolve(true)}
              >
                <Text
                  style={[
                    styles.alertBtnText,
                    req.destructive ? styles.alertBtnTextDestructive : styles.alertBtnTextPrimary,
                  ]}
                >
                  {req.confirmLabel}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    alertBackdrop: {
      flex: 1,
      backgroundColor: c.overlay,
      alignItems: 'center',
      justifyContent: 'center',
    },
    alertCard: {
      width: 360,
      maxWidth: '90%',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      padding: 20,
    },
    alertTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
    alertBody: { color: c.textMuted, fontSize: 13, marginTop: 8, lineHeight: 18 },
    alertBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
    alertBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
    alertBtnPrimary: { backgroundColor: c.accent },
    alertBtnDestructive: { backgroundColor: c.danger },
    alertBtnText: { color: c.textMuted, fontSize: 13, fontWeight: '600' },
    alertBtnTextPrimary: { color: c.accentText },
    alertBtnTextDestructive: { color: c.accentText },
  });
}

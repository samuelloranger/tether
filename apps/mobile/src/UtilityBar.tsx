import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Keyboard } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { ArrowCluster } from './Dpad';
import { MONO } from './styles';

// Mobile terminal-shortcuts utility bar — desktop uses the real keyboard.
export function UtilityBar({
  ctrlArmed,
  setCtrlArmed,
  sendInput,
  cursorSeq,
  onPaste,
}: {
  ctrlArmed: boolean;
  setCtrlArmed: (updater: (prev: boolean) => boolean) => void;
  sendInput: (s: string) => void;
  cursorSeq: (final: string) => string;
  onPaste: () => void;
}) {
  return (
    <View style={styles.utilityBar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.utilityScroll}
      >
        <TouchableOpacity
          style={[styles.utilityBtn, ctrlArmed && styles.utilityBtnActive]}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setCtrlArmed((v) => !v);
          }}
        >
          <Text style={[styles.utilityBtnText, ctrlArmed && styles.utilityBtnTextActive]}>Ctrl</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.utilityBtn}
          onPress={() => sendInput('\t')}
          onLongPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            sendInput('\x1b[Z');
          }}
        >
          <Text style={styles.utilityBtnText}>Tab</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b')}>
          <Text style={styles.utilityBtnText}>Esc</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[3~')}>
          <Text style={styles.utilityBtnText}>Del</Text>
        </TouchableOpacity>

        <View style={styles.utilityGroupDivider} />

        <ArrowCluster
          onArrow={(dir) => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            sendInput(cursorSeq(dir));
          }}
        />

        <View style={styles.utilityGroupDivider} />

        <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput(cursorSeq('H'))}>
          <Text style={styles.utilityBtnText}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput(cursorSeq('F'))}>
          <Text style={styles.utilityBtnText}>End</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[5~')}>
          <Text style={styles.utilityBtnText}>PgUp</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[6~')}>
          <Text style={styles.utilityBtnText}>PgDn</Text>
        </TouchableOpacity>

        <View style={styles.utilityGroupDivider} />

        <TouchableOpacity
          style={styles.utilityIconBtn}
          activeOpacity={0.6}
          onPress={onPaste}
          accessibilityRole="button"
          accessibilityLabel="Paste"
        >
          <Feather name="clipboard" size={17} color="#cbd5e1" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.utilityIconBtn}
          activeOpacity={0.6}
          onPress={() => Keyboard.dismiss()}
          accessibilityRole="button"
          accessibilityLabel="Hide keyboard"
        >
          <Feather name="chevron-down" size={18} color="#cbd5e1" />
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  utilityBar: {
    backgroundColor: '#0b0f19',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 8,
  },
  utilityScroll: {
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 6,
  },
  utilityBtn: {
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  utilityBtnText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    color: '#cbd5e1',
  },
  utilityBtnActive: {
    backgroundColor: '#22d3ee',
  },
  utilityBtnTextActive: {
    color: '#0b0f19',
  },
  utilityIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  utilityGroupDivider: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    marginHorizontal: 2,
  },
});
